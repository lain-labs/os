import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../../logger.js";

const log = createLogger("plugin:press:buffer-web");

/**
 * Posting through publish.buffer.com in a browser, for when Buffer's API is spent.
 *
 * Buffer's free API allows 1,000 requests a month per client and the desk can run
 * through them in days; the website has no such limit. This puts one post into a
 * channel's queue the way a person would: open the channel, New Post, type the text,
 * attach the picture, Schedule Post (Next Available).
 *
 * The browser is a persistent profile the operator signed into once
 * (LAINOS_BUFFER_WEB_PROFILE, default ~/.config/lainos/buffer-web). When a window with
 * that profile is already open with remote debugging (LAINOS_BUFFER_WEB_CDP), this
 * attaches to it instead, since a profile cannot be opened twice.
 *
 * playwright-core is not a dependency of LainOS: it is loaded from
 * LAINOS_PLAYWRIGHT_CORE (a path to its index.mjs) or resolved by name, and without
 * it this reports that it cannot post rather than failing the press plugin.
 */

export interface BufferWebSettings {
  getSetting(key: string): string | undefined;
}

export interface BufferWebPost {
  /** The Buffer channel's name as the sidebar shows it, e.g. "lain___os". */
  channel: string;
  text: string;
  imagePath?: string;
  /** "draft" saves it in Buffer's Drafts instead of the queue (for a dry run). */
  mode?: "queue" | "draft";
}

export interface BufferWebResult {
  ok: boolean;
  /** What went wrong, in words, when ok is false. */
  reason?: string;
}

interface PlaywrightCore {
  chromium: {
    connectOverCDP(endpoint: string): Promise<PwBrowser>;
    launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<PwContext>;
  };
}
interface PwBrowser { contexts(): PwContext[]; close(): Promise<void> }
interface PwContext { pages(): PwPage[]; newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwLocator {
  count(): Promise<number>;
  nth(i: number): PwLocator;
  first(): PwLocator;
  click(options?: Record<string, unknown>): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  setInputFiles(path: string): Promise<void>;
  waitFor(options?: Record<string, unknown>): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
}
interface PwPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  locator(selector: string): PwLocator;
  getByRole(role: string, options: Record<string, unknown>): PwLocator;
  keyboard: { insertText(text: string): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_CDP = "http://127.0.0.1:9334";
const PUBLISH = "https://publish.buffer.com";

export function bufferWebEnabled(settings: BufferWebSettings): boolean {
  return settings.getSetting("LAINOS_BUFFER_WEB") === "1";
}

async function loadPlaywright(settings: BufferWebSettings): Promise<PlaywrightCore | null> {
  const explicit = settings.getSetting("LAINOS_PLAYWRIGHT_CORE")?.trim();
  const candidates = [explicit, "playwright-core"].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    try {
      const spec = candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate;
      return (await import(spec)) as PlaywrightCore;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** Open the browser: the operator's window if it is up, else the same profile headless. */
async function openPage(pw: PlaywrightCore, settings: BufferWebSettings): Promise<{ page: PwPage; done: () => Promise<void> }> {
  const cdp = settings.getSetting("LAINOS_BUFFER_WEB_CDP")?.trim() || DEFAULT_CDP;
  try {
    const browser = await pw.chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0];
    if (context) {
      const page = await context.newPage();
      return { page, done: async () => { await page.close(); await browser.close(); } };
    }
    await browser.close();
  } catch {
    // no window open: launch the profile ourselves
  }
  const profile = settings.getSetting("LAINOS_BUFFER_WEB_PROFILE")?.trim() || join(homedir(), ".config", "lainos", "buffer-web");
  const chrome = settings.getSetting("LAINOS_BUFFER_WEB_CHROME")?.trim();
  const context = await pw.chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 860 },
    ...(chrome ? { executablePath: chrome } : {}),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { page, done: () => context.close() };
}

/** The header's New Post button (the sidebar has a hidden one with the same name). */
async function clickNewPost(page: PwPage): Promise<void> {
  const buttons = page.getByRole("button", { name: "New Post" });
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const box = await button.boundingBox();
    if (box && box.y < 160 && box.x > 600) {
      await button.click();
      return;
    }
  }
  throw new Error("Buffer's New Post button was not found");
}

export async function postViaBufferWeb(settings: BufferWebSettings, post: BufferWebPost): Promise<BufferWebResult> {
  const pw = await loadPlaywright(settings);
  if (!pw) return { ok: false, reason: "playwright-core is not available (set LAINOS_PLAYWRIGHT_CORE)" };
  if (post.imagePath && !existsSync(post.imagePath)) return { ok: false, reason: `image ${post.imagePath} is missing` };

  let opened: { page: PwPage; done: () => Promise<void> } | undefined;
  try {
    opened = await openPage(pw, settings);
    const { page } = opened;
    await page.goto(`${PUBLISH}/all-channels`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4000);
    if (/login|auth\./.test(page.url())) return { ok: false, reason: "the Buffer browser profile is signed out; sign in once in the Buffer window" };

    const channel = page.locator(`a[href*="/channels/"]:has-text("${post.channel.replace(/"/g, "")}")`).first();
    if ((await channel.count()) === 0) return { ok: false, reason: `channel ${post.channel} is not in this Buffer account` };
    const href = await channel.getAttribute("href");
    await page.goto(`${PUBLISH}${href?.split("?")[0] ?? ""}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3000);

    await clickNewPost(page);
    const editor = page.locator('[data-testid="composer-text-area"]');
    await editor.waitFor({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.insertText(post.text);

    if (post.imagePath) {
      await page.locator('[role="dialog"] input[type="file"]').first().setInputFiles(post.imagePath);
      // The thumbnail replaces the drop zone once the upload is done.
      await page.waitForTimeout(8000);
    }

    await page.getByRole("button", { name: post.mode === "draft" ? "Save Draft" : "Schedule Post" }).first().click();
    await page.locator('[data-testid="composer-text-area"]').waitFor({ state: "detached", timeout: 30_000 });
    log.info(`${post.mode === "draft" ? "saved as a Buffer draft" : "queued on publish.buffer.com"} for @${post.channel}`);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    log.warn(`Buffer web post failed: ${reason}`);
    return { ok: false, reason };
  } finally {
    await opened?.done().catch(() => undefined);
  }
}
