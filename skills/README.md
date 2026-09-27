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

Node builtins and installed dependencies (`viem`, `undici`) may be imported.
Broken modules are rejected at load with the error message. Built-in tools can
never be shadowed by a skill. These files are part of the repo on purpose:
Lain's learning is versioned and committed like any other code.
