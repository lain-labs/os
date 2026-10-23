import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IAgentRuntime } from "../types.js";
import { scrubSecrets } from "../plugins/journal/index.js";

export interface NodeJob {
  id: string;
  owner: string;
  task: string;
  status: "running" | "completed" | "failed" | "interrupted";
  createdAt: string;
  finishedAt?: string;
  text?: string;
  model?: string;
  error?: string;
}

/** Durable receipts; interrupted work is never replayed because it may have changed files. */
export class NodeJobs {
  private jobs: NodeJob[] = [];
  private active = false;
  private ready: Promise<void>;
  private file: string;

  constructor(private runtime: IAgentRuntime, directory: string) {
    this.file = join(directory, "node-jobs.json");
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    try {
      this.jobs = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const job of this.jobs) {
      if (job.status === "running") {
        job.status = "interrupted";
        job.error = "The daemon restarted while this task was running. Check its work before resubmitting.";
        job.finishedAt = new Date().toISOString();
      }
    }
    await this.save();
  }

  private async save(): Promise<void> {
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }

  async list(owner: string, id?: string): Promise<NodeJob[]> {
    await this.ready;
    return this.jobs.filter(job => job.owner === owner && (!id || job.id === id)).slice(-30).reverse();
  }

  async submit(owner: string, task: string, id: string = randomUUID()): Promise<NodeJob> {
    await this.ready;
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error("Invalid task id.");
    if (!task.trim() || task.length > 16000) throw new Error("Task must contain 1–16000 characters.");
    const existing = this.jobs.find(job => job.id === id);
    if (existing) {
      if (existing.owner !== owner || existing.task !== scrubSecrets(task)) throw new Error("Task id already used.");
      return existing;
    }
    if (this.active) throw new Error("The node is busy. Wait for its running task before submitting another.");
    this.active = true;
    const job: NodeJob = { id, owner, task: scrubSecrets(task), status: "running", createdAt: new Date().toISOString() };
    this.jobs.push(job);
    try { await this.save(); } catch (error) { this.jobs.pop(); this.active = false; throw error; }
    void this.run(job, task);
    return job;
  }

  private async run(job: NodeJob, task: string): Promise<void> {
    try {
      const result = await this.runtime.handleMessage({ roomId: `node-job:${job.id}`, userId: job.owner, text: task });
      job.text = scrubSecrets(result.text).slice(0, 48000);
      job.model = result.model;
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = scrubSecrets(error instanceof Error ? error.message : "Task failed.").slice(0, 2000);
    } finally {
      job.finishedAt = new Date().toISOString();
      try { await this.save(); } finally { this.active = false; }
    }
  }
}
