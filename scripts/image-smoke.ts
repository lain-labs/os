#!/usr/bin/env -S npx tsx
/**
 * Image plugin smoke test (offline — a stub model, no network).
 *
 * Pinned here:
 *   1. a picture is read out of a chat-completions answer as a data URL, and an
 *      answer without one is not mistaken for a picture;
 *   2. generate() writes the file under <data>/images and sends the team's
 *      picture rules with the prompt;
 *   3. the daily allowance refuses the picture after the cap;
 *   4. only generate_image files inside the images directory may be sent on —
 *      a path anywhere else in an action's data is ignored;
 *   5. press_picture hands the latest picture to chaos press_draft as
 *      image_base64, and refuses a file outside the images directory.
 *
 * Run: npm run image:smoke
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageService, imagePlugin, imagesFromTurn, latestImage, pictureFrom } from "../src/plugins/image/index.js";
import type { IAgentRuntime } from "../src/types.js";

let checks = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const answer = (url: string) => ({ choices: [{ message: { role: "assistant", images: [{ type: "image_url", image_url: { url } }] } }] });

// 1. Reading the picture.
const read = pictureFrom(answer(`data:image/png;base64,${PNG.toString("base64")}`));
check("a data URL picture is read", read?.mime === "image/png" && read.bytes.equals(PNG));
check("an answer with no picture is not one", pictureFrom({ choices: [{ message: { content: "sorry" } }] }) === null);
check("a remote URL is not fetched behind anyone's back", pictureFrom(answer("https://example.com/x.png")) === null);

// 2–3. Generating, with a stub model and a cap of two.
const dataDir = mkdtempSync(join(tmpdir(), "lainos-image-"));
const settings: Record<string, string> = {
  LAINOS_DATA_DIR: dataDir,
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_BASE_URL: "https://gateway.test/v1",
  LAINOS_IMAGE_DAILY_LIMIT: "2",
};
const runtime = { getSetting: (k: string) => settings[k] } as unknown as IAgentRuntime;
const sent: { url: string; body: { model?: string; modalities?: string[]; messages?: { content: string }[] } }[] = [];
const stub = (async (url: string, init: { body: string }) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ...answer(`data:image/png;base64,${PNG.toString("base64")}`), usage: { cost: 0.03 } }), { status: 200 });
}) as unknown as ConstructorParameters<typeof ImageService>[0];

const svc = new ImageService(stub);
await svc.start(runtime);
const first = await svc.generate("lain in the wired", "16:9");
check("the picture is written under <data>/images", first.path.startsWith(join(dataDir, "images")) && existsSync(first.path));
check("the gateway is asked for an image", sent[0]?.url === "https://gateway.test/v1/chat/completions" && Boolean(sent[0]?.body.modalities?.includes("image")));
check("the team's picture rules ride along", Boolean(sent[0]?.body.messages?.[0]?.content.includes("rockets")));
check("the cost is reported", first.costUsd === 0.03);

await svc.generate("second");
let refused = "";
try {
  await svc.generate("third");
} catch (err) {
  refused = (err as Error).message;
}
check("the third picture of a two-picture day is refused", refused.includes("allowance"), refused);
check("a refused picture never reaches the model", sent.length === 2);

// 4. What may be sent on.
const imagesDir = join(dataDir, "images");
const files = imagesFromTurn(
  [
    { name: "generate_image", result: { ok: true, data: { image: first.path } } },
    { name: "generate_image", result: { ok: true, data: { image: "/etc/passwd" } } },
    { name: "generate_image", result: { ok: true, data: { image: join(imagesDir, "..", "telegram.json") } } },
    { name: "run_shell", result: { ok: true, data: { image: first.path } } },
    { name: "generate_image", result: { ok: false, data: { image: first.path } } },
  ],
  imagesDir,
);
check("only the image action's own files are sent", files.length === 1 && files[0] === first.path, JSON.stringify(files));

// 5. The hand-over to the press desk.
check("the latest picture is found", (await latestImage(imagesDir)) === first.path);
const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
const office = {
  getSetting: (k: string) => settings[k],
  getService: (name: string) =>
    name === "mcp"
      ? { name: "mcp", call: async (server: string, tool: string, args: Record<string, unknown>) => (calls.push({ server, tool, args }), { ok: true, text: '{"saved":"draft","id":7}' }) }
      : undefined,
} as unknown as IAgentRuntime;
const press = imagePlugin.actions!.find((a) => a.name === "press_picture")!;
const handed = await press.handler(office, {} as never, { channel: "cyberia_chain", text: "Invite a friend." });
check(
  "the picture goes to press_draft as image_base64",
  handed.ok && calls[0]?.server === "chaos" && calls[0]?.tool === "press_draft" && String(calls[0]?.args.image_base64).startsWith("data:image/png;base64,"),
  JSON.stringify(handed),
);
const outside = await press.handler(office, {} as never, { channel: "cyberia_chain", text: "x", image: "/etc/hostname" });
check("a file outside the images directory is refused", !outside.ok && calls.length === 1);

console.log(`\n${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
