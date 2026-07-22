import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.js";

export function statePaths(env = process.env) {
  const root = env.LIVIS_CODEX_HOME || path.join(homedir(), ".livis-codex");
  return {
    root,
    config: path.join(root, "config.json"),
    tokens: path.join(root, "tokens.json"),
    state: path.join(root, "state.json"),
    agentId: path.join(root, "agent.id"),
    deviceId: path.join(root, "device.id"),
  };
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.message}`);
  }
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temp, file);
  await chmod(file, mode);
}

export async function ensureConfig(paths, overrides = {}) {
  const current = await readJson(paths.config, null);
  if (current) return mergeConfig(DEFAULT_CONFIG, current);
  const created = mergeConfig(DEFAULT_CONFIG, overrides);
  await writeJsonAtomic(paths.config, created);
  return created;
}

export async function loadConfig(paths) {
  const config = await readJson(paths.config, null);
  if (!config) {
    throw new Error(`Missing config: ${paths.config}. Run \`livis-codex setup\` first.`);
  }
  return mergeConfig(DEFAULT_CONFIG, config);
}

export function mergeConfig(base, extra) {
  return {
    ...base,
    ...extra,
    livis: { ...base.livis, ...extra?.livis },
    codex: { ...base.codex, ...extra?.codex },
    gateway: { ...base.gateway, ...extra?.gateway },
    dashboard: { ...base.dashboard, ...extra?.dashboard },
  };
}

async function loadOrCreateId(file, prefix) {
  try {
    const value = (await readFile(file, "utf8")).trim();
    if (value) return value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = `${prefix}${randomUUID()}`;
  await writeFile(file, `${value}\n`, { mode: 0o600 });
  return value;
}

export function loadOrCreateAgentId(paths) {
  return loadOrCreateId(paths.agentId, "openclaw-");
}

export function loadOrCreateDeviceId(paths) {
  return loadOrCreateId(paths.deviceId, "pc_");
}

export class StateStore {
  constructor(file) {
    this.file = file;
    this.value = { threads: {}, jobs: {} };
  }

  async load() {
    this.value = await readJson(this.file, { threads: {}, jobs: {} });
    this.value.threads ||= {};
    this.value.jobs ||= {};
    return this;
  }

  async save() {
    await writeJsonAtomic(this.file, this.value);
  }

  getThread(nodeId) {
    return this.value.threads[nodeId] || null;
  }

  async setThread(nodeId, threadId) {
    this.value.threads[nodeId] = threadId;
    await this.save();
  }

  getJob(jobId) {
    return this.value.jobs[jobId] || null;
  }

  async setJob(jobId, patch) {
    this.value.jobs[jobId] = {
      ...this.value.jobs[jobId],
      ...patch,
      updatedAt: Date.now(),
    };
    trimTerminalJobs(this.value.jobs, 50);
    await this.save();
  }

  async pruneJobs(ttlMs = 24 * 60 * 60 * 1000, maxJobs = 50) {
    const cutoff = Date.now() - ttlMs;
    for (const [id, job] of Object.entries(this.value.jobs)) {
      if (job.status === "completed" && job.updatedAt < cutoff) delete this.value.jobs[id];
    }
    trimTerminalJobs(this.value.jobs, maxJobs);
    await this.save();
  }

  async markRunningJobsInterrupted() {
    let changed = false;
    for (const job of Object.values(this.value.jobs)) {
      if (job.status !== "running" && job.status !== "queued" && job.status !== "ready") continue;
      job.status = "interrupted";
      job.phase = "interrupted";
      job.activity = "网关重启，任务已中断";
      job.updatedAt = Date.now();
      changed = true;
    }
    if (changed) await this.save();
  }
}

function trimTerminalJobs(jobs, maxJobs) {
  const entries = Object.entries(jobs);
  if (entries.length <= maxJobs) return;
  const protectedStatuses = new Set(["queued", "running", "ready"]);
  const removable = entries
    .filter(([, job]) => !protectedStatuses.has(job.status))
    .sort((left, right) => (left[1].updatedAt || 0) - (right[1].updatedAt || 0));
  let count = entries.length;
  for (const [id] of removable) {
    if (count <= maxJobs) break;
    delete jobs[id];
    count -= 1;
  }
}
