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
first run inside the conversation gets two.

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

## Agent Skills from skills.sh

Not to be confused with the tools above: an Agent Skill from
[skills.sh](https://skills.sh) is a playbook — `SKILL.md` and reference files —
that Lain reads, not code she runs. `find_skills` searches the directory,
`use_agent_skill` previews one by id (`owner/repo/skill`) or opens an installed
one, `install_agent_skill` puts it in `data/agent-skills/<name>/`, and
`remove_agent_skill` takes it away. `/skills find <query>` does the search from
the TUI or Telegram without a model call.
