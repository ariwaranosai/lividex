import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { VERSION } from "./constants.js";

export class CodexClient extends EventEmitter {
  constructor(config, { spawnFn = spawn, log = console } = {}) {
    super();
    this.config = config;
    this.spawnFn = spawnFn;
    this.log = log;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.threadStatuses = new Map();
  }

  async start() {
    if (this.child) return;
    this.child = this.spawnFn(this.config.binary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.cwd,
      env: process.env,
    });
    this.child.once("exit", (code, signal) => this.#onExit(code, signal));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (this.config.verbose || text.includes('"level":"ERROR"')) this.log.warn(`[codex] ${text}`);
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    await this.request("initialize", {
      clientInfo: { name: "livis-codex", title: "Livis Codex Gateway", version: VERSION },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill("SIGTERM");
  }

  request(method, params, { onResult = null } = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, onResult });
    });
    this.#send({ id, method, params });
    return response;
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  async createThread() {
    const params = {
      cwd: this.config.cwd,
      sandbox: this.config.sandbox,
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: this.config.approvalsReviewer,
      baseInstructions: this.config.baseInstructions,
      ephemeral: false,
    };
    if (this.config.model) params.model = this.config.model;
    const response = await this.request("thread/start", params);
    return response.thread.id;
  }

  async resumeThread(threadId) {
    const response = await this.request("thread/resume", { threadId });
    return response.thread.id;
  }

  async runTurn(threadId, text, { jobId = null, onTurnStarted = null } = {}) {
    return new Promise((resolve, reject) => {
      this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text }],
          effort: this.config.reasoningEffort,
          clientUserMessageId: jobId,
        },
        {
          onResult: (response) => {
            const turnId = response.turn.id;
            onTurnStarted?.(turnId);
            this.turns.set(turnId, {
              threadId,
              jobId,
              text: "",
              phase: "thinking",
              activity: "正在推理",
              startedAt: Date.now(),
              lastEventAt: Date.now(),
              resolve,
              reject,
            });
            this.#emitTurnStatus(turnId);
          },
        },
      ).catch(reject);
    });
  }

  async interrupt(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  status() {
    return {
      running: Boolean(this.child),
      activeTurns: [...this.turns.entries()].map(([turnId, turn]) => ({
        turnId,
        threadId: turn.threadId,
        jobId: turn.jobId,
        phase: turn.phase,
        activity: turn.activity,
        startedAt: turn.startedAt,
        lastEventAt: turn.lastEventAt,
        outputChars: turn.text.length,
      })),
      threadStatuses: [...this.threadStatuses.entries()].map(([threadId, status]) => ({ threadId, ...status })),
    };
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log.warn(`[codex] ignoring non-JSON stdout: ${line.slice(0, 300)}`);
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else {
        pending.onResult?.(message.result);
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#handleServerRequest(message);
      return;
    }
    this.#handleNotification(message);
  }

  #handleNotification(message) {
    const params = message.params || {};
    if (message.method === "item/started") {
      const detail = describeItem(params.item);
      this.#updateTurn(params.turnId, detail.phase, detail.activity);
    } else if (message.method === "item/agentMessage/delta") {
      const turn = this.turns.get(params.turnId);
      if (turn) turn.text += params.delta || "";
      this.#updateTurn(params.turnId, "responding", "正在组织回复");
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const turn = this.turns.get(params.turnId);
      if (turn && !turn.text && params.item.text) turn.text = params.item.text;
    } else if (message.method === "thread/status/changed") {
      this.threadStatuses.set(params.threadId, {
        status: normalizeThreadStatus(params.status),
        waitingOnApproval: Boolean(params.status?.activeFlags?.includes("waitingOnApproval")),
        waitingOnUserInput: Boolean(params.status?.activeFlags?.includes("waitingOnUserInput")),
        updatedAt: Date.now(),
      });
    } else if (message.method === "turn/completed") {
      const turn = this.turns.get(params.turn?.id);
      if (!turn) return;
      this.turns.delete(params.turn.id);
      if (params.turn.status === "completed") turn.resolve({ text: turn.text, turnId: params.turn.id });
      else turn.reject(new Error(params.turn.error?.message || `Codex turn ended with ${params.turn.status}`));
    }
    this.emit("notification", message);
  }

  #updateTurn(turnId, phase, activity) {
    const turn = this.turns.get(turnId);
    if (!turn || !phase) return;
    const changed = turn.phase !== phase || turn.activity !== activity;
    turn.phase = phase;
    turn.activity = activity;
    turn.lastEventAt = Date.now();
    if (changed) this.#emitTurnStatus(turnId);
  }

  #emitTurnStatus(turnId) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.emit("turnStatus", {
      turnId,
      threadId: turn.threadId,
      jobId: turn.jobId,
      phase: turn.phase,
      activity: turn.activity,
      startedAt: turn.startedAt,
      lastEventAt: turn.lastEventAt,
    });
  }

  #handleServerRequest(message) {
    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ]);
    if (approvalMethods.has(message.method)) {
      this.#send({ id: message.id, result: { decision: "decline" } });
      this.log.warn(`[codex] denied remote approval request: ${message.method}`);
      return;
    }
    this.#send({
      id: message.id,
      error: { code: -32601, message: `Unsupported server request: ${message.method}` },
    });
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onExit(code, signal) {
    const error = new Error(`Codex app-server exited (code=${code}, signal=${signal})`);
    this.child = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(error);
    this.turns.clear();
    this.emit("exit", error);
  }
}

function describeItem(item = {}) {
  switch (item.type) {
    case "reasoning": return { phase: "thinking", activity: "正在推理" };
    case "plan": return { phase: "planning", activity: "正在规划任务" };
    case "agentMessage": return { phase: "responding", activity: "正在组织回复" };
    case "commandExecution": return { phase: "tool", activity: previewActivity("正在执行命令", item.command) };
    case "fileChange": return { phase: "editing", activity: "正在修改本地文件" };
    case "mcpToolCall": return { phase: "tool", activity: previewActivity("正在调用工具", item.tool) };
    case "dynamicToolCall": return { phase: "tool", activity: previewActivity("正在调用工具", item.tool) };
    case "collabAgentToolCall": return { phase: "tool", activity: "正在协同处理任务" };
    case "webSearch": return { phase: "searching", activity: previewActivity("正在搜索", item.query) };
    case "imageGeneration": return { phase: "tool", activity: "正在生成图片" };
    default: return { phase: "working", activity: "Codex 正在处理" };
  }
}

function previewActivity(prefix, value) {
  const detail = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return detail ? `${prefix}：${detail.slice(0, 120)}` : prefix;
}

function normalizeThreadStatus(status) {
  if (typeof status === "string") return status;
  if (status?.type) return status.type;
  return Object.keys(status || {})[0] || "unknown";
}
