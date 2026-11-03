const assert = require('node:assert/strict');
const { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const workflow = readFileSync(join(__dirname, '../../../.github/workflows/apps.yml'), 'utf8');
const section = workflow.split('      - name: Name the APK\n')[1].split('      - name: Upload APK\n')[0];
const script = section.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const pattern = workflow.match(/pattern: (release-\*)/)[1];

for (const signed of [true, false]) {
    test(`${signed ? 'signed release' : 'debug'} APK has the correct download eligibility`, t => {
        const dir = mkdtempSync(join(tmpdir(), 'lainos-apk-test-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const type = signed ? 'release' : 'debug';
        mkdirSync(join(dir, `android/app/build/outputs/apk/${type}`), { recursive: true });
        writeFileSync(join(dir, `android/app/build/outputs/apk/${type}/app-${type}.apk`), 'test artifact');
        const output = join(dir, 'outputs');
        execFileSync('bash', ['-e', '-c', script.replaceAll('${{ steps.signing.outputs.signed }}', String(signed))], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output } });
        assert.equal(existsSync(join(dir, 'LainOS.apk')), signed);
        assert.equal(existsSync(join(dir, 'LainOS-debug.apk')), !signed);
        const artifact = readFileSync(output, 'utf8').trim().split('=')[1];
        assert.equal(artifact, signed ? 'release-android' : 'debug-android');
        assert.equal(artifact.startsWith(pattern.slice(0, -1)), signed);
    });
}
