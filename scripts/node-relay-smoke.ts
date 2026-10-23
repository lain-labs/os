import assert from 'node:assert/strict';
import { isNodeChat, relayNodeMessage } from '../src/clients/node-relay.js';
import { TelegramClient } from '../src/clients/telegram.js';
import type { IAgentRuntime } from '../src/types.js';

const values: Record<string, string> = { TELEGRAM_OPERATOR_ID: '42', LAINOS_NODE_TELEGRAM_CHATS: '-100', LAINOS_NODE_URL: 'http://node.test', LAINOS_NODE_KEY: 'private-test-key' };
const setting = (key: string) => values[key];
const sender = { id: 42, role: 'operator' as const, operatorKnown: true };
assert.equal(isNodeChat(-100, setting), true);
assert.equal(isNodeChat(42, setting), false);
let calls = 0;
const fakeFetch = async (_url: any, options: any) => {
  calls++;
  const body = JSON.parse(options.body);
  assert.equal(body.roomId, 'tg--100');
  assert.equal(body.metadata.telegram.role, 'operator');
  assert.equal(options.headers.Authorization, 'Bearer private-test-key');
  return Response.json({ text: 'Remote reply.', model: 'remote-model' });
};
await relayNodeMessage(setting, { chatId: -100, sender, text: 'Hello.' }, fakeFetch as typeof fetch);
await assert.rejects(relayNodeMessage(setting, { chatId: -100, sender: { ...sender, role: 'guest' }, text: 'Change files.' }, fakeFetch as typeof fetch), /Only the configured operator/);
assert.equal(calls, 1);
await assert.rejects(relayNodeMessage(setting, { chatId: -100, sender, text: 'Hello.' }, (async () => { throw new Error('network secret'); }) as typeof fetch), /did not send this to the local agent/);

let localCalls = 0;
const runtime = { getSetting: setting, handleMessage: async () => { localCalls++; return { text: 'Local reply.', actions: [] }; } } as unknown as IAgentRuntime;
const client = new TelegramClient(runtime) as any;
client.me = { id: 123, username: 'testbot' };
client.rememberChat = async () => {};
client.keepTyping = () => () => {};
const replies: string[] = [];
client.sendChunked = async (_id: number, text: string) => { replies.push(text); };
const originalFetch = globalThis.fetch;
globalThis.fetch = fakeFetch as typeof fetch;
try {
  await client.handleMessage({ message_id: 1, from: { id: 42 }, chat: { id: -100, type: 'group' }, text: '@testbot hello' });
  assert.equal(localCalls, 0);
  assert.match(replies.pop()!, /Remote reply.*\n\n⌁ server Lain/s);
  await client.handleMessage({ message_id: 2, from: { id: 7 }, chat: { id: -100, type: 'group' }, text: '@testbot hello' });
  assert.match(replies.pop()!, /Only the configured operator/);
  assert.equal(calls, 2);
  await client.handleMessage({ message_id: 3, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hello' });
  assert.equal(localCalls, 1);
  assert.match(replies.pop()!, /Local reply/);
} finally { globalThis.fetch = originalFetch; }
console.log('Node relay: remote routing, private local chat, trusted identity, operator gate and no local fallback passed.');
