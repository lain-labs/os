#!/usr/bin/env node
// Record the public Lain desktop preview and render it using HyperFrames.
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const execFile = promisify(callback);
const [outputArg, runtimeArg] = process.argv.slice(2);
if (!outputArg || !runtimeArg) throw new Error('Usage: press-demo.mjs OUTPUT_DIR MEDIA_RUNTIME');
const output = resolve(outputArg), runtime = resolve(runtimeArg), project = join(output, 'composition');
const dateMatch = output.match(/\d{4}-\d{2}-\d{2}/);
const date = dateMatch?.[0] ?? new Date().toISOString().slice(0, 10);
const variant = Math.floor(Date.parse(`${date}T00:00:00Z`) / 604800000) % 2;
const asset = join(project, 'assets'), videoDir = join(output, 'recording');
await mkdir(asset, { recursive: true, mode: 0o700 });
await mkdir(videoDir, { recursive: true, mode: 0o700 });
const { chromium } = await import(pathToFileURL(join(runtime, 'node_modules/playwright-core/index.mjs')).href);
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu'] });
let context;
let clip;
let offset = 0;
try {
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const began = Date.now();
  await page.goto('https://lain-os.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const optOut = page.getByRole('button', { name: /record/i });
  if (await optOut.count()) await optOut.first().click();
  // No authenticated profile, form submissions, keys or personal data enter the recording.
  offset = (Date.now() - began) / 1000;
  await page.waitForTimeout(2000);
  if (variant === 0) {
    await page.evaluate(() => window.scrollTo({ top: 650, behavior: 'smooth' }));
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.scrollTo({ top: 1320, behavior: 'smooth' }));
    await page.waitForTimeout(4000);
    await page.locator('#startBtn').scrollIntoViewIfNeeded();
    await page.locator('#startBtn').click();
    await page.evaluate(() => window.scrollBy({ top: -330, behavior: 'smooth' }));
    await page.waitForTimeout(6000);
  } else {
    await page.locator('#build').scrollIntoViewIfNeeded();
    await page.waitForTimeout(4000);
    await page.locator('#t-api').click();
    await page.waitForTimeout(4000);
    await page.locator('#t-mcp').click();
    await page.waitForTimeout(6000);
  }
  clip = page.video();
  await page.close();
} finally {
  await context?.close();
  await browser.close();
}
if (!clip) throw new Error('Browser did not produce a recording');
await copyFile(await clip.path(), join(asset, 'lain-ui.webm'));
await copyFile(join(runtime, 'node_modules/gsap/dist/gsap.min.js'), join(asset, 'gsap.min.js'));
await copyFile(join(runtime, 'music.wav'), join(asset, 'music.wav'));
const template = await readFile(new URL('./press-demo-template.html', import.meta.url), 'utf8');
await writeFile(join(project, 'index.html'), template.replace('data-media-start="13"', `data-media-start="${offset.toFixed(2)}"`));
await writeFile(join(output, 'brag-plan.md'), `# LainOS demo\n\nReal anonymous screen recording: ${variant === 0 ? 'open lain-os.com, scroll to the early-access desktop preview, open Start' : 'open lain-os.com, show the developer section and switch from API to MCP'}.\n\n18 seconds, landscape. No voiceover. Product footage is real; live numbers are historical at recording time.\n`);
await writeFile(join(output, 'composition-brief.md'), 'Use the actual recorded interface and preserve the early-access context. Quiet LainOS brand palette; no fabricated UI.\n');
await writeFile(join(output, 'share-copy.txt'), `${variant === 0 ? 'open Start in my public desktop preview' : 'one agent, multiple surfaces: the public API and MCP preview'}.\n\nrecorded ${date}.\n\nhttps://lain-os.com\n`);
const path = `${join(runtime, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`;
const cli = join(runtime, 'node_modules/.bin/hyperframes');
const run = async (...args) => execFile(cli, args, { cwd: project, env: { ...process.env, PATH: path }, timeout: 360000, maxBuffer: 8_000_000 });
await run('check', '--json');
await run('preview', '--background');
try {
  await run('render', '--quality', 'looks', '--output', join(output, 'brag.mp4'));
} finally {
  await run('preview', '--stop').catch(() => {});
}
const ffmpeg = join(runtime, 'bin/ffmpeg');
await execFile(ffmpeg, ['-loglevel', 'error', '-y', '-ss', '11', '-i', join(output, 'brag.mp4'), '-frames:v', '1', '-q:v', '2', join(output, 'brag.jpg')], { timeout: 60000 });
await execFile(ffmpeg, ['-loglevel', 'error', '-y', '-i', join(output, 'brag.mp4'), '-i', join(output, 'brag.jpg'), '-filter_complex', "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]", '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', join(output, 'poster.mp4')], { timeout: 180000 });
await rename(join(output, 'poster.mp4'), join(output, 'brag.mp4'));
await writeFile(join(output, 'REVIEW.md'), '# Automated checks\n\nHyperFrames check passed. This is an unreviewed recording of the public early-access preview. Inspect the video before publication; recorded chain numbers are historical.\n');
console.log(`Demo ready: ${join(output, 'brag.mp4')}`);
