import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferService } from "../src/plugins/buffer/index.js";
import type { IAgentRuntime } from "../src/types.js";

const dir = await mkdtemp(join(tmpdir(), "lain-buffer-test-"));
const settings: Record<string, string> = { LAINOS_DATA_DIR: dir, LAINOS_BUFFER_ENABLED: "1", BUFFER_API_KEY: "fake-token", LAINOS_BUFFER_ORGANIZATION_ID: "org", LAINOS_BUFFER_CHANNEL_IDS: "channel" };
const runtime = { getSetting: (key: string) => settings[key] } as IAgentRuntime;
const originalFetch = globalThis.fetch;
let calls = 0;
let fail = false;
let pages = 0;
let lastInput: Record<string, unknown> | undefined;
globalThis.fetch = (async (_url, init) => {
  calls++;
  const body = JSON.parse(String(init?.body));
  assert.equal((init?.headers as Record<string, string>).authorization, "Bearer fake-token");
  if (body.query.includes("mutation CreatePost")) {
    lastInput = body.variables.input;
    if (fail) throw new Error("connection lost");
    return Response.json({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "post-1" } } } });
  }
  if (body.query.includes("query Metrics")) {
    pages++;
    return Response.json({ data: { posts: { edges: [{ node: { id: `post-${pages}`, text: "hello", channelId: "channel", dueAt: null, metrics: [], metricsUpdatedAt: null } }], pageInfo: { endCursor: pages === 1 ? "next" : null, hasNextPage: pages === 1 } } } });
  }
  throw new Error("unexpected request");
}) as typeof fetch;
try {
  let svc = new BufferService(runtime);
  await svc.start();
  await svc.enqueue("press-day", "hello");
  await svc.enqueue("press-day", "hello");
  assert.equal(calls, 1, "repeat must not create another post");
  await assert.rejects(svc.enqueue("press-day", "changed"), /different post/);
  await svc.stop();
  svc = new BufferService(runtime);
  await svc.start();
  await svc.enqueue("press-day", "hello");
  assert.equal(calls, 1, "restart must retain the submission");
  fail = true;
  await assert.rejects(svc.enqueue("uncertain", "hello"), /connection lost/);
  fail = false;
  await svc.stop();
  svc = new BufferService(runtime);
  await svc.start();
  await assert.rejects(svc.enqueue("uncertain", "hello"), /unknown outcome/);
  assert.equal(calls, 2, "uncertain mutation must not be resent after restart");
  const snapshot = await svc.collect();
  assert.equal(snapshot.posts.length, 2, "all pages are collected");
  assert.equal(svc.latest()?.posts.length, 2);
  const stored = await readFile(join(dir, "buffer.json"), "utf8");
  assert(!stored.includes("fake-token"), "token must not be stored with analytics");
  settings.LAINOS_PRESS_REQUIRE_MEDIA = "1";
  await assert.rejects(svc.enqueue("no-media", "hello"), /requires an image or video/);
  await svc.enqueue("with-media", "hello", ["channel"], { kind: "image", url: "https://example.com/image.jpg" });
  assert.deepEqual(lastInput?.assets, [{ image: { url: "https://example.com/image.jpg" } }]);
  await svc.stop();
  console.log("Buffer smoke: duplicate prevention, restart, uncertain outcome, pagination and secret handling passed");
} finally {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
