// Log several wishes on the forge wishboard in one call (a bulleted list of
// features becomes one wish per item). Skips titles already open on the board.
const MAX_WISHES = 12;

export default {
  name: "log_wishes",
  similes: ["add_to_forge", "queue_for_forge", "log_many_wishes", "forge_these"],
  description:
    "Add several wishes to the forge wishboard at once — use when someone lists multiple features ('add to forge: • a • b • c'). One wish per item; titles already open on the board are skipped. Returns every wish id so you can tell the user.",
  parameters: {
    type: "object",
    properties: {
      wishes: {
        type: "array",
        description: "The wishes to log, in order.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative summary." },
            detail: { type: "string", description: "Everything needed to build it." },
          },
          required: ["title"],
        },
      },
    },
    required: ["wishes"],
  },
  async handler(runtime, state, params = {}) {
    const forge = runtime.getService?.("forge");
    if (!forge || typeof forge.addWish !== "function") {
      return { ok: false, text: "Forge service is not available." };
    }
    const items = Array.isArray(params.wishes) ? params.wishes.slice(0, MAX_WISHES) : [];
    if (!items.length) return { ok: false, text: "Give at least one wish with a title." };

    const roomId = String(state?.roomId ?? "");
    const chatId = roomId.startsWith("tg-") && Number.isFinite(Number(roomId.slice(3)))
      ? Number(roomId.slice(3))
      : undefined;
    const norm = (s) => String(s ?? "").trim().toLowerCase();
    const open = new Set(forge.listWishes("open").map((w) => norm(w.title)));

    const logged = [];
    const skipped = [];
    for (const item of items) {
      const title = String(item?.title ?? "").trim();
      if (!title) continue;
      if (open.has(norm(title))) {
        skipped.push(title);
        continue;
      }
      const wish = await forge.addWish({
        title,
        detail: item.detail ? String(item.detail) : undefined,
        reporter: state?.message?.userId ?? "unknown",
        chatId,
      });
      open.add(norm(title));
      logged.push({ id: wish.id, title: wish.title });
    }
    if (!logged.length && !skipped.length) return { ok: false, text: "No wish had a title." };
    const lines = logged.map((w) => `${w.id}: ${w.title}`);
    const text =
      (logged.length ? `Logged ${logged.length} wish(es):\n${lines.join("\n")}` : "Nothing new to log.") +
      (skipped.length ? `\nAlready open, skipped: ${skipped.join("; ")}` : "");
    return { ok: true, text, data: { logged, skipped } };
  },
};
