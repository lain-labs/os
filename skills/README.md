# skills/ — Lain's hot-loaded tools

Each `*.mjs` file here is one tool, hot-loaded into the running agent (no
restart). Lain writes these herself with `create_skill`; the forge and the
operator may also drop files in — the directory is watched.

Module contract (see `uptime.mjs` for a live example):

```js
export default {
  name: "snake_case_name",        // becomes the tool name; must match the file
  description: "What it does — the model reads this to decide when to call it.",
  parameters: {                    // JSON schema for the tool input (optional)
    type: "object",
    properties: { text: { type: "string", description: "…" } },
    required: ["text"],
  },
  async handler(runtime, state, params, kit) {
    // kit: the skill's standard library (below); runtime.getSetting(...), etc.
    return { ok: true, text: "result", data: { anything: "structured" } };
  },
};
```

## The kit

The fourth handler argument, so a tool written from one sentence does not
have to rediscover the chain's quirks (`skill_kit` prints the full reference
for the model):

```js
const chain = await kit.chain("robinhood");          // or the active chain
const trades = await chain.trades(wallets, { hours: 48 });
// [{ wallet, token, symbol, side: "buy"|"sell", value, opens, tx, block, at }]
// one per wallet, transaction and token; only transactions the wallet signed
const prices = await kit.prices(trades.map((t) => t.token)); // DexScreener USD
const seen = await kit.store.get("seen", []);        // the skill's own state
const info = await kit.tool("token_info", { token }); // any tool that reads
```

`chain.transfers` reads Transfer logs for many wallets at once in windows the
RPC accepts (a refused range is split, a 429 or a Cloudflare challenge waited
out); `chain.trades` looks up who signed each transaction (paced, retried) and
fails loudly rather than under-count when it cannot tell. Settled windows and
signers are cached in `data/kit-cache.json`, so a re-run reads only new
blocks. `kit.chain()` returns the reader at once — `await` is optional. `kit.tool` refuses tools that move funds or
change Lain herself, and `execute`/`confirm` arguments. `kit.http` names a
Cloudflare challenge page instead of failing on bad JSON; `kit.save` writes
big outputs to the workspace exports; `kit.viem` is the viem module. Data a
skill returns is made plain JSON (a BigInt becomes a string), so it can never
break the turn.

Skills that use a secret must use it and never return it: read it with
`runtime.getSetting`, and scrub it from every error string.

A skill that spends money must be two-step. `launch_token.mjs` issues a token on
the configured launchpad contract (a `LaunchpadNative`-style ABI, native
currency burned into permanently locked liquidity — requires
`CHAIN_LAUNCHPAD_ADDRESS`): called without `execute` it only reads the chain
and returns a plan — launchpad identity and router check, token parameters,
exact spend and gas, balance left afterwards, and what can never be undone —
ending in a confirmation phrase that encodes the symbol, the supply and the
native amount. Signing needs `execute: true` plus that phrase repeated back,
so changing any term of the plan invalidates an earlier confirmation, and
every launch is appended to `data/launches.json`. The private key is never
read: signing goes through the `chain` service's wallet client. Its safety
behaviour is covered by `npm run smoke` (`launch needs confirmation`).

## Changing a skill

Tools change as the strategy does ("ignore trades below $500"). Lain reads the
source with `read_skill` and changes it with `edit_skill`: a list of exact
replacements (each `old` must occur once in the source), applied in order,
answered with the before/after of each — the rest of the module cannot drift
the way a from-memory rewrite does. `create_skill` under an existing name
still rewrites a skill whole. The replaced version is kept in
`data/skills-history/<name>/` together with `changes.json`, the change log in
the operator's words (`note`); an edit that fails to load is refused and the
working version stays live; `revert_skill` steps back one version at a time,
`remove_skill` unloads a skill and keeps its last version in history.

## Routines: skills that run on their own

`schedule_skill` turns a skill into a routine: called with fixed arguments on
an interval (`every: "6h"`, at least 5 minutes), daily at a host-local time
(`at: "09:00"`, skipped if the desk slept more than 3 h past it), or whenever
the sentinel fires (`on: "sentinel"`, optionally one `watch`; the alert arrives
as `params.event`). The first timed run happens right away and sets the
baseline. After that a routine reports only when its result changed — the
skill's `data.fingerprint` if it returns one, else its `data`, else its text —
or after every run with `notify: "always"`. Reports go to the Telegram chat the
routine was created from (else every known chat) and to the TUI feed.
`list_routines`, `run_routine` and `stop_routine` manage them.

A background run may take five minutes (`LAINOS_ROUTINE_TIMEOUT_MS`); the
conversation waits 90 s for the first run (`LAINOS_ROUTINE_FIRST_WAIT_MS`), and
a longer one finishes in the background and is reported like any routine
result.

Routines run in the daemon (or any process with `LAINOS_ROUTINES=1`); every
process can create and list them through the shared `data/routines.json`. Only
self-written skills can be scheduled, never with `execute`/`confirm`
arguments — spending stays a two-step act in a conversation — and a routine
that fails five times in a row pauses itself and says so.

Node builtins and installed dependencies (`viem`, `undici`) may be imported —
from a skills directory outside the package too (it gets a `node_modules`
link at start).
Broken modules are rejected at load with the error message. Built-in tools can
never be shadowed by a skill. These files are part of the repo on purpose:
Lain's learning is versioned and committed like any other code.

## How loading works

The loader is `src/plugins/skills/index.ts` (`SkillsService`, the management
tools and the `skills` provider), with `kit.ts` (the kit), `routines.ts`
(`RoutineService`) and `registry.ts` (skills.sh) beside it.

### Entry points

- `createAgent()` in `src/index.ts` builds every process: the daemon
  (`npm run serve`, `scripts/serve.ts`, sets `LAINOS_DAEMON=1`), the TUI
  (`scripts/tui.ts`) and `scripts/chat.ts`. It registers each plugin the
  character names; Lain's list (`src/characters/lain.ts`) includes `"skills"`,
  which `BUILTIN_PLUGINS` maps to `skillsPlugin`.
- `skillsPlugin` brings two services, `skills` (`SkillsService`) and
  `routines` (`RoutineService`), the `skills` provider and the management
  tools: `create_skill`, `edit_skill`, `read_skill`, `revert_skill`,
  `remove_skill`, `list_skills`, `reload_skills`, `skill_kit`, the routine
  tools and the skills.sh tools.
- While the process runs, a module goes live through one of three paths: the
  directory watcher, a management tool, or `reload_skills`.

### Start-up sequence

1. `createAgent` builds the `AgentRuntime`. Its settings are `process.env`
   with `LAINOS_DATA_DIR` pinned.
2. `runtime.use(plugin)` runs for each plugin in the character's order. It
   appends the plugin's actions and providers and registers its services by
   name. Nothing starts yet, so every plugin's actions are in
   `runtime.actions` before any service starts.
3. `runtime.start()` starts the services one after another, in registration
   order (`chain`, `sentinel`, …, `skills`, `routines`, `mcp`, …).
4. `SkillsService.start(runtime)`:
   1. resolves the directory from `LAINOS_SKILLS_DIR` (default `./skills`,
      relative to the working directory; the daemon runs from the repo) and the
      history directory `<LAINOS_DATA_DIR>/skills-history`;
   2. records the name of every action already in `runtime.actions` as
      built-in. A skill can never take one of these names. The record is made
      once, so tools added later (remote MCP tools) are not in it;
   3. creates the directory if it does not exist;
   4. links `<dir>/node_modules` to the package's `node_modules` when the
      directory lies outside the package (the package's copy is found by
      resolving `viem`);
   5. runs `syncAll()`, which loads every top-level `*.mjs` and `*.js` file;
   6. watches the directory with `fs.watch` and runs `syncAll()` 400 ms after
      the last change. If the directory cannot be watched, only
      `reload_skills` re-syncs.
5. `RoutineService.start(runtime)` reads `<LAINOS_DATA_DIR>/routines.json`.
   Routines run in this process when `LAINOS_ROUTINES` is set to anything but
   `0`, or, if it is unset, when `LAINOS_DAEMON=1`. Such a process ticks every
   `LAINOS_ROUTINES_TICK_MS` (default 30 s, minimum 5 s) and subscribes to
   the `sentinel` service's alerts.

### Loading one module (`loadFile`)

1. The file is imported as `file://…?v=<mtime>`. A changed mtime gives a fresh
   module instance; an unchanged file comes from Node's module cache and its
   code does not run again.
2. The default export must be an object with:
   - a `name` matching `^[a-z][a-z0-9_]{1,40}$` that is not a built-in;
   - a non-empty `description`;
   - a `handler` function.

   `create_skill` and `edit_skill` also require `name` to equal the skill being
   written (`<name>.mjs`). A directory sync does not check this: there the
   module's `name` is the tool name, whatever the file is called.
3. `skillToAction` wraps the module in a runtime `Action`:
   - The description gets ` (self-written skill)` appended.
   - `parameters` defaults to an empty object schema.
   - `validate` always passes.
   - The handler calls `handler(runtime, state, params, kit)` with a fresh
     `makeKit(...)`. It normalises the result to
     `{ ok: res.ok !== false, text, data }`, with `data` turned into plain
     JSON (BigInt → string).
   - A throw becomes `{ ok: false, text: "skill <name> threw: …" }`, so a
     broken skill never ends the turn.
4. The action replaces the one of the same name in `runtime.actions`, or is
   appended.

Every turn, `buildState` validates all actions and `buildToolSchemas` sends
the result to the model as its tool list. A skill loaded during a turn is
therefore missing from that turn's list. A call to it by name still runs,
because the tool loop looks names up in `runtime.actions` at call time. From
the next turn on, the skill is listed normally. The `skills` provider also
names up to 30 self-written tools, the routines and the skills.sh shelf in
the context of every turn.

### Lifecycle

| Event | What happens |
| --- | --- |
| A file appears or changes in the directory | The watcher runs `syncAll()`; changed files are re-imported |
| `create_skill` (new name) | The file is written and loaded. If it fails to load, the file is deleted and the error is returned. Logged as `create` |
| `create_skill` (existing name) / `edit_skill` | The old source goes to history, the new source is written and loaded. If it fails to load, the old source is restored and stays live. Logged as `rewrite` / `edit` |
| `revert_skill` | The newest history version is written back and loaded, then removed from history |
| `remove_skill` / the file is deleted | The action is removed from `runtime.actions`. `remove_skill` first keeps the last version in history |
| A file is edited by hand and no longer loads | On the next sync the error is logged and returned by `reload_skills`, and the tool is dropped from the live set until the file loads again. There is no rollback: rollback belongs to `create_skill`/`edit_skill` |
| The process stops | `stop()` closes the watcher; the files and history stay on disk |

Each new version is a new module instance. Node keeps the earlier ones in
memory until the process restarts. A skill's own relative imports
(`./lib/x.mjs`) are not cache-busted, and the watcher does not see
subdirectories. A changed helper therefore needs a restart. Keep helpers out
of the top level: there, every `*.mjs` file is loaded as a skill.

### Dependencies

- **Services:** every management tool's `validate` requires the `skills`
  service, so the tools hide without it. Routines need `skills` to schedule
  and `sentinel` for `on: "sentinel"`. `kit.chain` and `kit.prices` resolve
  the chain profile from the chain settings.
- **Settings:** `LAINOS_SKILLS_DIR`, `LAINOS_DATA_DIR`, `LAINOS_DAEMON`,
  `LAINOS_ROUTINES`, `LAINOS_ROUTINES_TICK_MS`, `LAINOS_ROUTINE_TIMEOUT_MS`
  and `LAINOS_ROUTINE_FIRST_WAIT_MS`.
- **Files under `LAINOS_DATA_DIR`:**
  - `skills-history/<name>/` holds the replaced versions and `changes.json`
    (the last 100 changes);
  - `skill-state/<name>.json` is `kit.store`;
  - `kit-cache.json` holds the chain read cache;
  - `routines.json` holds the routines;
  - `agent-skills/` is the skills.sh shelf.

### Adding a skill

Example module, `skills/word_delta.mjs`:

```js
export default {
  name: "word_delta",
  description: "Count the words in a text and say how the count changed since the last call with the same key.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to count." },
      key: { type: "string", description: "What the count belongs to, e.g. 'draft'." },
    },
    required: ["text"],
  },
  async handler(_runtime, _state, params, kit) {
    const key = String(params.key ?? "default");
    const words = String(params.text ?? "").split(/\s+/).filter(Boolean).length;
    const before = await kit.store.get(key, null);
    await kit.store.set(key, words);
    const delta = before === null ? "first count" : `${words - before >= 0 ? "+" : ""}${words - before} since last time`;
    return { ok: true, text: `${words} words (${delta})`, data: { words, fingerprint: String(words) } };
  },
};
```

There are three ways to register it:

- **Drop the file in** (the operator or the forge): the watcher loads it
  within half a second. Run `reload_skills` to see a load error.
- **Ask Lain:** `create_skill` with `name: "word_delta"`, the source as `code`
  and the request as `note`. The module is checked, written, loaded and
  recorded in its change log.
- **In code or a test:** point `LAINOS_SKILLS_DIR` at a directory, register
  `skillsPlugin` and start its services. `scripts/skills-smoke.ts` boots a
  minimal runtime this way (`npm run skills:smoke`). TypeScript code can
  import the `SkillModule` type from `src/index.ts`.

A capability that needs a background service, signing or changes to `src/`
is too big for a skill: `learn_skill` (the forge) builds it instead.

## Agent Skills from skills.sh

Not to be confused with the tools above: an Agent Skill from
[skills.sh](https://skills.sh) is a playbook — `SKILL.md` and reference files —
that Lain reads, not code she runs. `find_skills` searches the directory,
`use_agent_skill` previews one by id (`owner/repo/skill`) or opens an installed
one, `install_agent_skill` puts it in `data/agent-skills/<name>/`, and
`remove_agent_skill` takes it away. `/skills find <query>` does the search from
the TUI or Telegram without a model call.
