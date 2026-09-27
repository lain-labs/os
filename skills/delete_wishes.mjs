const CLEARABLE_STATUSES = new Set(["done", "rejected", "failed", "review"]);
const ALL_STATUSES = new Set(["open", "building", "review", "done", "rejected", "failed"]);

function normalizeIds(params) {
  const raw = [
    ...(Array.isArray(params.ids) ? params.ids : []),
    ...(typeof params.idText === "string" ? params.idText.split(/[\s,]+/) : []),
  ];
  const ids = [];
  const invalid = [];
  for (const value of raw) {
    const id = String(value ?? "").trim().toLowerCase();
    if (!id) continue;
    if (!/^wish\d+$/.test(id)) {
      invalid.push(String(value));
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid };
}

function normalizeStatuses(params) {
  const raw = params.clearClosed
    ? [...CLEARABLE_STATUSES]
    : Array.isArray(params.clearStatuses)
      ? params.clearStatuses
      : [];
  const statuses = [];
  const invalid = [];
  const refused = [];
  for (const value of raw) {
    const status = String(value ?? "").trim().toLowerCase();
    if (!status) continue;
    if (!ALL_STATUSES.has(status)) {
      invalid.push(String(value));
      continue;
    }
    if (!CLEARABLE_STATUSES.has(status)) {
      refused.push(status);
      continue;
    }
    if (!statuses.includes(status)) statuses.push(status);
  }
  return { statuses, invalid, refused };
}

function describeWish(wish) {
  return `${wish.id} [${wish.status}] ${wish.title}`;
}

function boardText(wishes) {
  if (!wishes.length) return "Remaining wishboard is empty.";
  return `Remaining wishboard:\n${wishes.map(describeWish).join("\n")}`;
}

async function persistForge(forge) {
  if (typeof forge.persist === "function") {
    await forge.persist.call(forge);
    return;
  }
  throw new Error("forge service does not expose persistence");
}

export default {
  name: "delete_wishes",
  similes: ["remove_wishes", "clear_wishboard", "prune_wishboard"],
  description:
    "Delete specific wish ids from the persistent forge wishboard, or clear only closed/review/failed entries. Use when the operator asks to remove wishboard records; the result lists the board afterward for verification.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Exact wish ids to delete, e.g. ['wish1', 'wish3'].",
      },
      idText: {
        type: "string",
        description: "Optional whitespace/comma-separated wish ids to delete, e.g. 'wish1 wish3 wish5'.",
      },
      clearStatuses: {
        type: "array",
        items: { type: "string", enum: ["done", "rejected", "failed", "review"] },
        description: "Delete all wishes with these statuses. Open/building cannot be cleared by status.",
      },
      clearClosed: {
        type: "boolean",
        description: "When true, delete all done, rejected, failed, and review wishes.",
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would be deleted without writing the wishboard.",
      },
      allowBuilding: {
        type: "boolean",
        description: "Permit deleting explicitly named building wishes. Defaults to false.",
      },
    },
  },
  async handler(runtime, _state, params = {}) {
    const forge = runtime.getService?.("forge");
    if (!forge || typeof forge.listWishes !== "function") {
      return { ok: false, text: "Forge service is not available." };
    }
    if (!Array.isArray(forge.wishes)) {
      return { ok: false, text: "Forge service does not expose the live wishboard array." };
    }

    const { ids, invalid: invalidIds } = normalizeIds(params);
    const {
      statuses,
      invalid: invalidStatuses,
      refused: refusedStatuses,
    } = normalizeStatuses(params);

    if (invalidIds.length) return { ok: false, text: `Invalid wish id(s): ${invalidIds.join(", ")}.` };
    if (invalidStatuses.length) {
      return { ok: false, text: `Invalid wish status(es): ${invalidStatuses.join(", ")}.` };
    }
    if (refusedStatuses.length) {
      return {
        ok: false,
        text: `Refusing broad delete for status(es): ${refusedStatuses.join(", ")}. Name exact ids instead.`,
      };
    }
    if (!ids.length && !statuses.length) {
      return {
        ok: false,
        text: "Give exact ids, clearStatuses, or clearClosed=true. Nothing was deleted.",
      };
    }

    const wishes = forge.wishes;
    const explicit = new Set(ids);
    const selected = wishes.filter((wish) => explicit.has(wish.id) || statuses.includes(wish.status));
    const selectedIds = new Set(selected.map((wish) => wish.id));
    const missing = ids.filter((id) => !wishes.some((wish) => wish.id === id));
    const blockedBuilding = selected.filter((wish) => wish.status === "building" && !params.allowBuilding);
    if (blockedBuilding.length) {
      return {
        ok: false,
        text: `Refusing to delete building wish(es): ${blockedBuilding.map((wish) => wish.id).join(", ")}. Pass allowBuilding=true only if the active job is safe to orphan.`,
      };
    }
    if (!selected.length) {
      return {
        ok: true,
        text: `No matching wishes found.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}\n${boardText(forge.listWishes())}`,
        data: { deleted: [], missing },
      };
    }

    const remaining = wishes.filter((wish) => !selectedIds.has(wish.id));
    if (!params.dryRun) {
      forge.wishes = remaining;
      await persistForge(forge);
    }
    const after = params.dryRun ? wishes : forge.listWishes();
    const verb = params.dryRun ? "Would delete" : "Deleted";
    const suffix = missing.length ? ` Missing: ${missing.join(", ")}.` : "";
    return {
      ok: true,
      text: `${verb} ${selected.length} wish(es): ${selected.map((wish) => wish.id).join(", ")}.${suffix}\n${boardText(after)}`,
      data: {
        deleted: params.dryRun ? [] : [...selectedIds],
        wouldDelete: params.dryRun ? [...selectedIds] : [],
        missing,
        remaining: after.length,
      },
    };
  },
};
