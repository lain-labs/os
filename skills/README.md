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
  async handler(runtime, state, params) {
    // runtime.getService("chain"), runtime.getSetting(...), etc.
    return { ok: true, text: "result", data: { anything: "structured" } };
  },
};
```

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
source with `read_skill` and writes the new version under the same name with
`create_skill`. The replaced version is kept in `data/skills-history/<name>/`;
an edit that fails to load is refused and the working version stays live;
`revert_skill` steps back one version at a time, `remove_skill` unloads a skill
and keeps its last version in history.

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

Routines run in the daemon (or any process with `LAINOS_ROUTINES=1`); every
process can create and list them through the shared `data/routines.json`. Only
self-written skills can be scheduled, never with `execute`/`confirm`
arguments — spending stays a two-step act in a conversation — and a routine
that fails five times in a row pauses itself and says so.

Node builtins and installed dependencies (`viem`, `undici`) may be imported.
Broken modules are rejected at load with the error message. Built-in tools can
never be shadowed by a skill. These files are part of the repo on purpose:
Lain's learning is versioned and committed like any other code.
