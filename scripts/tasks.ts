#!/usr/bin/env -S npx tsx
/**
 * Show or change the running daemon's **task routing** — which model answers
 * which kind of work:
 *
 *   npm run tasks                                    # the whole table
 *   npm run tasks digest openrouter:openrouter/free  # point one kind somewhere
 *   npm run tasks digest default                     # back to the environment's choice
 *
 * The change is immediate and persisted (data/task-routes.json), so it also
 * survives the daemon's next restart. The TUI is a separate process with its
 * own runtime: use /tasks there.
 */
import "dotenv/config";
import { TASKS, TASK_ORDER, isTaskKind } from "../src/models/tasks.js";
import type { TaskRouteState } from "../src/models/routing.js";

const host = process.env.LAINOS_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.LAINOS_HTTP_PORT ?? 7777);
const base = `http://${host}:${port}`;

const row = (r: TaskRouteState): string =>
  `  ${r.emoji} ${r.task.padEnd(10)} ${r.provider}${r.model ? ` · ${r.model}` : ""}` +
  `  (${r.source})${r.error ? `  ⚠ ${r.error}` : ""}`;

async function main() {
  const task = process.argv[2]?.trim().toLowerCase();
  const route = process.argv.slice(3).join(" ").trim();

  if (task && !isTaskKind(task)) {
    console.error(`unknown kind "${task}" — one of: ${TASK_ORDER.join(", ")}`);
    process.exit(1);
  }
  const kind = task && isTaskKind(task) ? task : undefined;

  let res: Response;
  try {
    res =
      task && route
        ? await fetch(`${base}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task, route }),
          })
        : await fetch(`${base}/tasks`);
  } catch {
    console.error(
      `no daemon on ${base} — start it with "npm run serve" or "systemctl --user start lainos".`,
    );
    process.exit(1);
  }

  const body = (await res.json()) as {
    routes?: TaskRouteState[];
    route?: TaskRouteState;
    error?: string;
  };
  if (!res.ok) {
    console.error(body.error ?? `daemon answered ${res.status}`);
    process.exit(1);
  }

  if (body.route) {
    console.log(`now:\n${row(body.route)}`);
    if (body.route.critical) {
      console.log("  ⚠ this kind acts on the world (money/code) — trust that model.");
    }
    return;
  }

  const rows = body.routes ?? [];
  if (kind) {
    const one = rows.find((r) => r.task === kind);
    if (one) console.log(`${row(one)}\n  ${TASKS[kind].desc}`);
    console.log(`change it: npm run tasks ${kind} <provider[:model]>`);
    return;
  }
  console.log(rows.map(row).join("\n"));
  console.log("change one: npm run tasks <kind> <provider[:model]>");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
