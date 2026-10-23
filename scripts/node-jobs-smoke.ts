import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeJobs } from '../src/clients/node-jobs.js';
import type { IAgentRuntime } from '../src/types.js';

const directory = await mkdtemp(join(tmpdir(), 'lain-node-jobs-'));
let calls = 0;
let finish!: (value: any) => void;
const runtime = { getSetting: () => undefined, handleMessage: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } } as unknown as IAgentRuntime;
try {
  const jobs = new NodeJobs(runtime, directory);
  const first = await jobs.submit('owner-a', 'Inspect files.', 'test-job-123');
  assert.equal(first.status, 'running');
  await jobs.submit('owner-a', 'Inspect files.', 'test-job-123');
  assert.equal(calls, 1);
  assert.deepEqual(await jobs.list('owner-b'), []);
  await assert.rejects(jobs.submit('owner-b', 'Inspect files.', 'test-job-123'), /already used/);
  await assert.rejects(jobs.submit('owner-a', 'Another task.', 'test-job-456'), /busy/);
  finish({ text: 'Done.', model: 'test-model' });
  for (let i = 0; i < 100 && !(await readFile(join(directory, 'node-jobs.json'), 'utf8')).includes('completed'); i++) await new Promise(r => setTimeout(r, 10));
  const restored = new NodeJobs(runtime, directory);
  assert.equal((await restored.list('owner-a'))[0].text, 'Done.');
  await jobs.submit('owner-a', 'Second task.', 'test-job-456');
  const restarted = new NodeJobs(runtime, directory);
  assert.equal((await restarted.list('owner-a'))[0].status, 'interrupted');
  assert.equal(calls, 2);
  finish({ text: 'Done.', model: 'test-model' });
  await new Promise(r => setTimeout(r, 30));
  console.log('Node jobs: durable results, owner isolation, idempotency, busy guard and restart interruption passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
