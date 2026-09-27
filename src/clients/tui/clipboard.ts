/**
 * Copying text out of the TUI.
 *
 * Two independent routes, because either one alone leaves someone stuck:
 *
 *  - OSC 52 asks the *terminal* to set the clipboard, so it works over ssh and
 *    inside tmux — but plenty of terminals ship with it disabled, and it caps
 *    the payload.
 *  - A local clipboard helper (wl-copy, xclip, xsel, pbcopy, clip.exe) is
 *    reliable when the TUI runs on the same machine as the desktop, and knows
 *    nothing about a remote session.
 *
 * Both are attempted; the caller is told which ones actually ran so the
 * confirmation in the feed can say something true.
 */
import { spawn } from "node:child_process";

/** Terminals refuse (or truncate) very large OSC 52 payloads. */
const OSC52_LIMIT = 64 * 1024;

const HELPERS: { cmd: string; args: string[] }[] = [
  { cmd: "wl-copy", args: [] },
  { cmd: "xclip", args: ["-selection", "clipboard"] },
  { cmd: "xsel", args: ["--clipboard", "--input"] },
  { cmd: "pbcopy", args: [] },
  { cmd: "clip.exe", args: [] },
];

/** Push `text` to the terminal's clipboard with OSC 52. */
export function osc52(text: string, write: (s: string) => void): void {
  const b64 = Buffer.from(text.slice(0, OSC52_LIMIT), "utf8").toString("base64");
  write(`\x1b]52;c;${b64}\x07`);
}

/**
 * Hand `text` to the first local clipboard helper that runs. Best-effort and
 * asynchronous: resolves to the helper's name, or null when none of them is
 * installed (a headless box, or a remote session where OSC 52 is the answer).
 */
export async function localClipboard(text: string): Promise<string | null> {
  for (const { cmd, args } of HELPERS) {
    const ok = await new Promise<boolean>((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      child.on("error", () => done(false)); // ENOENT: not installed
      child.on("close", (code) => done(code === 0));
      child.stdin?.on("error", () => done(false));
      child.stdin?.end(text);
    });
    if (ok) return cmd;
  }
  return null;
}
