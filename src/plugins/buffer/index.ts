import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "../../logger.js";
import type { Action, IAgentRuntime } from "../../types.js";

const log = createLogger("plugin:buffer");
const ENDPOINT = "https://api.buffer.com";

type Metric = { type: string; name: string; value: number; unit: string };
export type BufferPost = { id: string; text: string; channelId: string; dueAt: string | null; sentAt?: string | null; status?: string; externalLink?: string | null; metrics: Metric[] | null; metricsUpdatedAt: string | null };
type Media = { kind: "image" | "video"; url: string };
type Submission = { channelId: string; text: string; media?: Media; state: "sending" | "queued" | "rejected"; postId?: string; error?: string; updatedAt: string };
type Snapshot = { collectedAt: string; posts: BufferPost[] };
type Store = { submissions: Record<string, Submission>; snapshots: Record<string, Snapshot>; lastError?: string };

/** An uncertain mutation is never retried automatically: Buffer offers no idempotency key. */
export class BufferService {
  private store: Store = { submissions: {}, snapshots: {} };
  private file = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private initial: ReturnType<typeof setTimeout> | null = null;
  private collecting = false;
  private writes: Promise<void> = Promise.resolve();
  constructor(private runtime: IAgentRuntime) {}

  get enabled(): boolean { return this.runtime.getSetting("LAINOS_BUFFER_ENABLED") === "1"; }
  get autoPost(): boolean { return this.enabled && this.runtime.getSetting("LAINOS_BUFFER_AUTO_POST") === "1"; }
  get channelIds(): string[] { return (this.runtime.getSetting("LAINOS_BUFFER_CHANNEL_IDS") ?? "").split(",").map(s => s.trim()).filter(Boolean); }
  get organizationId(): string { return (this.runtime.getSetting("LAINOS_BUFFER_ORGANIZATION_ID") ?? "").trim(); }
  get lastError(): string | undefined { return this.store.lastError; }
  latest(): Snapshot | undefined { return Object.values(this.store.snapshots).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0]; }
  submission(key: string, channelId: string): Submission | undefined { return this.store.submissions[`${key}:${channelId}`]; }

  async start(): Promise<void> {
    this.file = join(this.runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "buffer.json");
    try { this.store = JSON.parse(await readFile(this.file, "utf8")) as Store; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    this.store.submissions ??= {}; this.store.snapshots ??= {};
    if (!this.enabled || this.runtime.getSetting("LAINOS_DAEMON") !== "1") return;
    const configured = Number(this.runtime.getSetting("LAINOS_BUFFER_ANALYTICS_INTERVAL_MS") ?? 86400000);
    const interval = Number.isFinite(configured) ? Math.max(3600000, configured) : 86400000;
    this.timer = setInterval(() => void this.collect().catch(err => log.warn("analytics collection failed", err)), interval);
    this.timer.unref?.();
    this.initial = setTimeout(() => void this.collect().catch(err => log.warn("analytics collection failed", err)), 30000);
    this.initial.unref?.();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); if (this.initial) clearTimeout(this.initial); await this.writes; }

  private async save(): Promise<void> {
    // Serialize writes so two simultaneous tasks cannot overwrite newer state.
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.store, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.file);
    });
    await this.writes;
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const key = this.runtime.getSetting("BUFFER_API_KEY")?.trim();
    if (!key) throw new Error("BUFFER_API_KEY is missing");
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Buffer HTTP ${res.status}`);
    const body = await res.json() as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Buffer GraphQL: ${body.errors.map(e => e.message).join("; ")}`);
    if (!body.data) throw new Error("Buffer returned no data");
    return body.data;
  }

  async channels(): Promise<{ id: string; name: string; service: string }[]> {
    if (!this.organizationId) throw new Error("LAINOS_BUFFER_ORGANIZATION_ID is missing");
    const data = await this.query<{ channels: { id: string; name: string; service: string }[] }>(`query Channels($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name service } }`, { org: this.organizationId });
    return data.channels;
  }

  async enqueue(key: string, text: string, channelIds = this.channelIds, media?: Media): Promise<Submission[]> {
    if (!this.enabled) throw new Error("Buffer is disabled");
    if (!this.runtime.getSetting("BUFFER_API_KEY")?.trim()) throw new Error("BUFFER_API_KEY is missing");
    if (!text.trim() || !channelIds.length) throw new Error("A post and at least one Buffer channel are required");
    if (this.runtime.getSetting("LAINOS_PRESS_REQUIRE_MEDIA") === "1" && !media) throw new Error("This account requires an image or video for every post");
    if (media && (!/^https:\/\//i.test(media.url) || !["image", "video"].includes(media.kind))) throw new Error("Media needs a public HTTPS URL and image or video type");
    const results: Submission[] = [];
    for (const channelId of [...new Set(channelIds)]) {
      const id = `${key}:${channelId}`;
      const prior = this.store.submissions[id];
      if (prior?.state === "queued") {
        if (prior.text !== text || JSON.stringify(prior.media ?? null) !== JSON.stringify(media ?? null)) throw new Error(`A different post is already queued for ${id}`);
        results.push(prior); continue;
      }
      if (prior?.state === "sending") throw new Error(`Buffer submission ${id} has an unknown outcome; inspect Buffer before resolving it`);
      const entry: Submission = { channelId, text, ...(media ? { media } : {}), state: "sending", updatedAt: new Date().toISOString() };
      this.store.submissions[id] = entry;
      await this.save();
      // A network timeout, HTTP error or GraphQL error can occur after acceptance.
      // Leave the marker in place instead of risking another public post.
      const data = await this.query<{ createPost: { __typename: string; post?: { id: string }; message?: string } }>(
        `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id } } ... on MutationError { message } } }`,
        { input: { text, channelId, schedulingType: "automatic", mode: "addToQueue", ...(media ? { assets: [{ [media.kind]: { url: media.url } }] } : {}) } },
      );
      const result = data.createPost;
      if (result.__typename !== "PostActionSuccess" || !result.post?.id) {
        entry.state = "rejected"; entry.error = result.message ?? `Unexpected result ${result.__typename}`; entry.updatedAt = new Date().toISOString();
        await this.save();
        throw new Error(`Buffer rejected the post: ${entry.error}`);
      }
      entry.state = "queued"; entry.postId = result.post.id; entry.updatedAt = new Date().toISOString();
      await this.save(); results.push(entry);
    }
    return results;
  }

  async collect(): Promise<Snapshot> {
    if (this.collecting) throw new Error("Buffer analytics collection already running");
    if (!this.enabled || !this.organizationId || !this.channelIds.length) throw new Error("Buffer analytics is not configured");
    this.collecting = true;
    try {
      const posts: BufferPost[] = [];
      let after: string | null = null;
      for (let page = 0; page < 100; page++) {
        const data: { posts: { edges: { node: BufferPost }[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } } } = await this.query(
          `query Metrics($org: OrganizationId!, $channels: [ChannelId!], $after: String) { posts(first: 50, after: $after, input: { organizationId: $org, filter: { status: [sent], channelIds: $channels } }) { edges { node { id text channelId dueAt sentAt status externalLink metrics { type name value unit } metricsUpdatedAt } } pageInfo { endCursor hasNextPage } } }`,
          { org: this.organizationId, channels: this.channelIds, after },
        );
        posts.push(...data.posts.edges.map(e => e.node));
        if (!data.posts.pageInfo.hasNextPage) break;
        if (!data.posts.pageInfo.endCursor || data.posts.pageInfo.endCursor === after) throw new Error("Buffer returned an invalid pagination cursor");
        after = data.posts.pageInfo.endCursor;
        if (page === 99) throw new Error("Buffer analytics exceeds 100 pages");
      }
      const collectedAt = new Date().toISOString();
      const snapshot = { collectedAt, posts };
      this.store.snapshots[collectedAt.slice(0, 10)] = snapshot;
      delete this.store.lastError;
      await this.save();
      return snapshot;
    } catch (err) {
      this.store.lastError = (err as Error).message;
      await this.save();
      throw err;
    } finally { this.collecting = false; }
  }
}

function service(runtime: IAgentRuntime): BufferService | undefined {
  return runtime.getService<{ name: string; buffer?: BufferService }>("press")?.buffer;
}

export const bufferActions: Action[] = [
  {
    name: "buffer_channels", similes: ["list_buffer_channels"], description: "List connected Buffer channels for posting.", parameters: { type: "object", properties: {} }, examples: [{ user: "show Buffer channels", agent: "checking Buffer" }],
    async validate(runtime) { return !!service(runtime)?.enabled; },
    async handler(runtime) { try { const channels = await service(runtime)!.channels(); return { ok: true, text: JSON.stringify(channels), data: { channels } }; } catch (err) { return { ok: false, text: (err as Error).message }; } },
  },
  {
    name: "buffer_queue_post", similes: ["schedule_buffer_post", "publish_via_buffer"], description: "Queue the supplied text and public image or video URL in Buffer. Use only when the operator asks to post or schedule it. Repeated requests for identical text, media and channels are deduplicated unless a new requestId is supplied.", parameters: { type: "object", properties: { text: { type: "string", description: "Exact post text" }, channelId: { type: "string", description: "Optional Buffer channel ID" }, mediaUrl: { type: "string", description: "Public HTTPS URL accessible to Buffer through publication" }, mediaType: { type: "string", enum: ["image", "video"] }, requestId: { type: "string", description: "Unique ID for an intentional repeat; reuse it when retrying" } }, required: ["text"] }, examples: [{ user: "queue this text on Buffer", agent: "adding it to the queue" }],
    async validate(runtime) { return !!service(runtime)?.enabled; },
    async handler(runtime, _state, params) { try { const svc = service(runtime)!; const content = String(params.text ?? ""); const channels = params.channelId ? [String(params.channelId)] : svc.channelIds; const media = params.mediaUrl ? { url: String(params.mediaUrl), kind: String(params.mediaType ?? "image") as Media["kind"] } : undefined; const key = params.requestId ? String(params.requestId) : createHash("sha256").update(JSON.stringify([content, [...channels].sort(), media ?? null])).digest("hex"); const posts = await svc.enqueue(`manual-${key}`, content, channels, media); return { ok: true, text: "Added to the Buffer queue; it is not yet confirmed published.", data: { posts } }; } catch (err) { return { ok: false, text: (err as Error).message }; } },
  },
  {
    name: "buffer_analytics", similes: ["social_analytics", "buffer_metrics"], description: "Read the latest collected Buffer post metrics, or refresh them on request. Metrics are experimental and unavailable metrics are not zero.", parameters: { type: "object", properties: { refresh: { type: "boolean", description: "Fetch latest metrics from Buffer" } } }, examples: [{ user: "how are our posts performing?", agent: "checking the latest Buffer metrics" }],
    async validate(runtime) { return !!service(runtime)?.enabled; },
    async handler(runtime, _state, params) { try { const svc = service(runtime)!; const snapshot = params.refresh === true ? await svc.collect() : svc.latest(); if (!snapshot) return { ok: false, text: `No Buffer analytics snapshot yet.${svc.lastError ? ` Last error: ${svc.lastError}` : ""}` }; return { ok: true, text: `Buffer experimental post metrics collected ${snapshot.collectedAt}; ${snapshot.posts.length} sent posts. Missing metrics are unavailable, not zero.`, data: { ...snapshot } }; } catch (err) { return { ok: false, text: (err as Error).message }; } },
  },
];
