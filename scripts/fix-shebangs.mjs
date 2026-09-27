#!/usr/bin/env node
// tsc copies a source file's shebang verbatim into its compiled output. Our
// scripts use `#!/usr/bin/env -S npx tsx` so `npm run chat`-style dev
// commands need no separate build step — but the compiled dist/*.js is run
// directly with `node` (by the systemd units and by the npm `bin` entries a
// global install links), and re-invoking tsx there makes npx fetch it fresh
// from an arbitrary CWD with no local node_modules to find. Rewrite the
// shebang in the compiled output only; the .ts sources are untouched.
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC_SHEBANG = "#!/usr/bin/env -S npx tsx";
const DIST_SHEBANG = "#!/usr/bin/env node";

function fixDir(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      fixDir(path);
      continue;
    }
    if (!name.endsWith(".js")) continue;
    const text = readFileSync(path, "utf8");
    if (!text.startsWith(SRC_SHEBANG)) continue;
    writeFileSync(path, DIST_SHEBANG + text.slice(SRC_SHEBANG.length), "utf8");
    chmodSync(path, 0o755); // a shebang script needs +x to run as a linked bin
  }
}

fixDir(new URL("../dist/scripts", import.meta.url).pathname);
