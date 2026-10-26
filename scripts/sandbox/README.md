# Security sandbox

`find → prove → fix → verify` needs a place where *prove* cannot hurt anyone.
`run.sh` builds a throwaway image from `git archive HEAD` of a repository
(tracked files only: no `.env`, no `data/`, no wallet files), optionally adds a
directory of proof-of-concept files, installs dependencies with install
scripts off, and runs one command with:

- `--network none` — the exploit cannot reach a chain, an API or the operator's LAN;
- no environment from the host, so no keys;
- every capability dropped, `no-new-privileges`, uid 1000;
- a read-only root (only `/tmp` is writable), pid/memory/cpu ceilings and a timeout;
- the container and the image deleted afterwards.

```bash
# Prove a finding against the commit as it is (the test is expected to fail)…
npm run sandbox -- . --with ./poc -- npx tsx scripts/http-smoke.ts
# …then fix, commit, and run the same command again.
```

`SANDBOX_IMAGE` picks another base (e.g. a Foundry or PHP image),
`SANDBOX_SETUP` another install step, `SANDBOX_TIMEOUT` the wall clock.

The coding agent that reads the code and writes the proof runs outside: it
needs its model. What runs inside is the proof itself — the code nobody has
read yet.
