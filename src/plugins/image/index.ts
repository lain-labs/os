/**
 * Pictures on request: Lain draws with an image model and hands the file to
 * whoever asked — in Telegram, as a photo in the same chat.
 *
 * The model is reached through the same OpenAI-compatible endpoint as the
 * chat models (OPENROUTER_BASE_URL / OPENROUTER_API_KEY — lain-os.com's own
 * gateway on the daemon), with `modalities: ["image", "text"]`; the gateway
 * only lists models that can also answer in text, which is why the default is
 * a Gemini image model and not an image-only one. LAINOS_IMAGE_MODEL changes it.
 *
 * A picture costs real money (about $0.03 on the default model), and a group
 * chat is a place where anyone may ask for one, so there is a daily cap
 * (LAINOS_IMAGE_DAILY_LIMIT, default 40) counted on disk, and the team's
 * picture rules ride along with every prompt: no rising price charts, rockets,
 * real people's faces or other brands' logos (LAINOS_IMAGE_RULES).
 *
 * Files land in `<LAINOS_DATA_DIR>/images/`. The action returns the path in
 * `data.image`; the Telegram client sends only files from that directory, so
 * no other action can get a file off the disk by naming it.
 *
 * `press_picture` is the office's hand-over: a picture the team liked in the
 * chat goes to the press desk on chaos.fm (through the chaos MCP's
 * `press_draft`, with the bytes as `image_base64`) as a draft a person
 * approves — the same picture, not a new one drawn from the same words.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { createLogger } from "../../logger.js";
import type { Action, ActionResult, IAgentRuntime, Plugin, Service } from "../../types.js";

const log = createLogger("plugin:image");

export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-lite-image";
export const DEFAULT_IMAGE_RULES =
  "Never draw a price chart going up, up arrows or rockets, real people's faces, or other brands' logos.";
const DEFAULT_DAILY_LIMIT = 40;
const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
type Aspect = (typeof ASPECTS)[number];
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export interface GeneratedImage {
  path: string;
  mime: string;
  model: string;
  /** What the gateway said it cost, when it said. */
  costUsd?: number;
}

type Fetch = typeof undiciFetch;

/** The first picture in a chat-completions answer, as bytes and a type. Pure — pinned by the smoke test. */
export function pictureFrom(body: unknown): { bytes: Buffer; mime: string } | null {
  const images = (body as { choices?: { message?: { images?: unknown[] } }[] })?.choices?.[0]?.message?.images;
  const first = Array.isArray(images) ? (images[0] as { image_url?: { url?: unknown } } | undefined) : undefined;
  const url = typeof first?.image_url?.url === "string" ? first.image_url.url : "";
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(url);
  if (!match) return null;
  const bytes = Buffer.from(match[2]!, "base64");
  return bytes.length ? { bytes, mime: match[1]! } : null;
}

/**
 * The pictures one turn produced that may be sent on, in order.
 *
 * Only files the image action wrote, inside the images directory: a path
 * anywhere else in an action's data is ignored, whatever named it.
 */
export function imagesFromTurn(
  actions: { name: string; result: ActionResult }[] | undefined,
  imagesDir: string,
): string[] {
  const root = resolve(imagesDir) + sep;
  const out: string[] = [];
  for (const { name, result } of actions ?? []) {
    if (name !== "generate_image" || !result.ok) continue;
    const path = typeof result.data?.image === "string" ? resolve(result.data.image) : "";
    if (path.startsWith(root) && !out.includes(path)) out.push(path);
  }
  return out;
}

export function imagesDir(runtime: Pick<IAgentRuntime, "getSetting">): string {
  return resolve(runtime.getSetting("LAINOS_DATA_DIR") || "./data", "images");
}

export class ImageService implements Service {
  readonly name = "image";

  private runtime?: IAgentRuntime;
  private dispatcher?: Dispatcher;
  private dir = "";

  constructor(private readonly fetchImpl: Fetch = undiciFetch) {}

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.dir = imagesDir(runtime);
    const proxy = runtime.getSetting("LAINOS_MODEL_PROXY") ?? runtime.getSetting("HTTPS_PROXY");
    if (proxy) this.dispatcher = new ProxyAgent(proxy);
  }

  /** Whether a key is configured at all — the action hides itself otherwise. */
  configured(): boolean {
    return Boolean(this.setting("LAINOS_IMAGE_API_KEY") ?? this.setting("OPENROUTER_API_KEY"));
  }

  async generate(prompt: string, aspect: Aspect = "1:1"): Promise<GeneratedImage> {
    const key = this.setting("LAINOS_IMAGE_API_KEY") ?? this.setting("OPENROUTER_API_KEY");
    if (!key) throw new Error("no image model key: set OPENROUTER_API_KEY or LAINOS_IMAGE_API_KEY");
    await this.spend();

    const base = (
      this.setting("LAINOS_IMAGE_BASE_URL") ??
      this.setting("OPENROUTER_BASE_URL") ??
      "https://openrouter.ai/api/v1"
    ).replace(/\/+$/, "");
    const model = this.setting("LAINOS_IMAGE_MODEL") ?? DEFAULT_IMAGE_MODEL;
    const rules = this.setting("LAINOS_IMAGE_RULES") ?? DEFAULT_IMAGE_RULES;

    const res = await this.fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "X-Title": "LainOS" },
      body: JSON.stringify({
        model,
        modalities: ["image", "text"],
        image_config: { aspect_ratio: aspect },
        messages: [{ role: "user", content: `${prompt.trim()}\n\n${rules}` }],
      }),
      signal: AbortSignal.timeout(180_000),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    const body = (await res.json().catch(() => null)) as { error?: { message?: string }; usage?: { cost?: number } } | null;
    if (!res.ok) throw new Error(`image model ${res.status}: ${body?.error?.message ?? "no answer"}`);
    const picture = pictureFrom(body);
    if (!picture) throw new Error("the image model answered without a picture");

    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const hash = createHash("sha256").update(picture.bytes).digest("hex").slice(0, 8);
    const path = join(this.dir, `${stamp}-${hash}.${TYPES[picture.mime] ?? "png"}`);
    await writeFile(path, picture.bytes);
    log.info(`image ${path} (${model}${typeof body?.usage?.cost === "number" ? `, $${body.usage.cost.toFixed(4)}` : ""})`);
    return {
      path,
      mime: picture.mime,
      model,
      ...(typeof body?.usage?.cost === "number" ? { costUsd: body.usage.cost } : {}),
    };
  }

  /** Take one picture from today's allowance, or refuse. */
  private async spend(): Promise<void> {
    const limit = Number(this.setting("LAINOS_IMAGE_DAILY_LIMIT") ?? DEFAULT_DAILY_LIMIT);
    const file = join(this.dir, "quota.json");
    const day = new Date().toISOString().slice(0, 10);
    let used = 0;
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as { day?: string; used?: number };
      if (saved.day === day) used = Number(saved.used) || 0;
    } catch {
      // First picture of the install.
    }
    if (Number.isFinite(limit) && limit >= 0 && used >= limit) {
      throw new Error(`today's picture allowance is used up (${limit}); it resets at 00:00 UTC — the operator can raise LAINOS_IMAGE_DAILY_LIMIT`);
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, JSON.stringify({ day, used: used + 1 }), "utf8");
  }

  private setting(key: string): string | undefined {
    const value = this.runtime?.getSetting(key)?.trim();
    return value ? value : undefined;
  }
}

const generateImageAction: Action = {
  name: "generate_image",
  similes: ["draw", "make_image", "make_picture", "image", "picture", "illustration", "art"],
  description:
    "Draw a picture with an image model and attach it to your reply (in Telegram it arrives as a photo in the same chat). " +
    "Write the prompt in English, concrete: subject, composition, style, colours, and any exact text that must appear in quotes. " +
    "For Cyberia or Lain OS posts follow the team's picture style (chaos context section 'style-images' when the chaos MCP is connected): " +
    "Serial Experiments Lain / Wired mood, dark CRT glow, scanlines, monospace UI fragments, cyan and magenta accents. " +
    "Never draw rising price charts, rockets, real people's faces or other brands' logos. Costs money and has a daily cap — one picture per request unless asked for more.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to draw, in English." },
      aspect: { type: "string", enum: [...ASPECTS], description: "Shape: 1:1 (default), 16:9 for X posts, 9:16 for stories." },
    },
    required: ["prompt"],
  },
  examples: [
    { user: "@lain draw a banner for the referral program", agent: "Drawing it — one moment." },
    { user: "make a picture of you in the wired, 16:9", agent: "On it." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService<ImageService>("image")?.configured());
  },
  async handler(runtime, _state, params) {
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) return { ok: false, text: "generate_image needs a prompt" };
    const aspect = ASPECTS.includes(params.aspect as Aspect) ? (params.aspect as Aspect) : "1:1";
    const svc = runtime.getService<ImageService>("image");
    if (!svc) return { ok: false, text: "the image plugin is not loaded" };
    try {
      const image = await svc.generate(prompt, aspect);
      return {
        ok: true,
        text:
          `picture ready (${image.model}${image.costUsd !== undefined ? `, $${image.costUsd.toFixed(3)}` : ""}) — ` +
          "it is attached to your reply automatically; describe it in a line, don't paste the path.",
        data: { image: image.path, mime: image.mime, model: image.model },
      };
    } catch (err) {
      return { ok: false, text: `couldn't draw it: ${(err as Error).message}` };
    }
  },
};

const EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** The newest picture this install drew, for "send that one". */
export async function latestImage(dir: string): Promise<string | null> {
  let newest: { path: string; at: number } | null = null;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!(extname(name).slice(1) in EXTENSIONS)) continue;
    const path = join(dir, name);
    const at = (await stat(path)).mtimeMs;
    if (!newest || at > newest.at) newest = { path, at };
  }
  return newest?.path ?? null;
}


const pressPictureAction: Action = {
  name: "press_picture",
  similes: ["send_picture_to_press", "queue_picture", "picture_to_press", "post_with_picture"],
  description:
    "Hand a picture you drew (generate_image) to the team's press desk on chaos.fm as a draft post with that exact picture — a person approves it there before anything is published. " +
    "Use it when the operator or a guest says to queue / post / send to press a picture from this chat. " +
    "Write the post text first, following the chaos context 'style-posts' (English, at most 280 characters, a link counts as 23). " +
    "Needs the chaos MCP server connected.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", enum: ["cyberia_chain", "lain___os"], description: "The X account the post is for." },
      text: { type: "string", description: "The post exactly as it should go out." },
      image: { type: "string", description: "The picture's path from generate_image; leave out for the latest picture." },
      why: { type: "string", description: "One line for the person approving." },
    },
    required: ["channel", "text"],
  },
  examples: [{ user: "@lain put that picture in the queue for cyberia with a post about invites", agent: "Writing the post and sending it to the desk." }],
  async validate(runtime) {
    return Boolean(runtime.getService("mcp"));
  },
  async handler(runtime, _state, params) {
    const dir = imagesDir(runtime);
    const wanted = typeof params.image === "string" && params.image.trim() ? resolve(params.image.trim()) : await latestImage(dir);
    if (!wanted || !wanted.startsWith(dir + sep)) return { ok: false, text: "no picture of mine to send — draw one with generate_image first" };
    const mime = EXTENSIONS[extname(wanted).slice(1)];
    if (!mime) return { ok: false, text: "that file is not one of my pictures" };
    const mcp = runtime.getService<Service & { call(server: string, tool: string, args: Record<string, unknown>): Promise<ActionResult> }>("mcp");
    if (!mcp) return { ok: false, text: "the mcp plugin is not loaded" };
    const bytes = await readFile(wanted);
    const result = await mcp.call("chaos", "press_draft", {
      channel: String(params.channel ?? ""),
      text: String(params.text ?? ""),
      image_base64: `data:${mime};base64,${bytes.toString("base64")}`,
      ...(typeof params.why === "string" && params.why.trim() ? { why: params.why.trim() } : {}),
      via: "Lain",
    });
    return result.ok
      ? { ok: true, text: `on the desk as a draft: ${result.text}` }
      : { ok: false, text: `the desk did not take it: ${result.text}` };
  },
};

export const imagePlugin: Plugin = {
  name: "image",
  description: "Draws pictures with an image model and hands them to the chat that asked.",
  services: [new ImageService()],
  actions: [generateImageAction, pressPictureAction],
};
