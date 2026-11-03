// Writes package.json's version into the manifest and packs src/ as LainOS-extension.zip.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const manifestPath = new URL('../src/manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath));
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
rmSync(new URL('../LainOS-extension.zip', import.meta.url), { force: true });
execFileSync('zip', ['-qrX', '../LainOS-extension.zip', '.'], { cwd: new URL('../src', import.meta.url) });
console.log(`LainOS-extension.zip ${version}`);
