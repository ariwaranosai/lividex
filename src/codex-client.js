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
              events: [],
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
        events: turn.events.map(({ key, ...event }) => event),
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
      const detail = describeItem(params.item, this.config.cwd);
      this.#recordItemStarted(params.turnId, params.item);
      this.#updateTurn(params.turnId, detail.phase, detail.activity);
    } else if (message.method === "item/reasoning/summaryTextDelta") {
      this.#appendReasoningSummary(params);
    } else if (message.method === "turn/plan/updated") {
      this.#recordPlan(params);
    } else if (message.method === "item/agentMessage/delta") {
      const turn = this.turns.get(params.turnId);
      if (turn) turn.text += params.delta || "";
      this.#updateTurn(params.turnId, "responding", "正在组织回复");
    } else if (message.method === "item/completed") {
      const turn = this.turns.get(params.turnId);
      this.#recordItemCompleted(params.turnId, params.item);
      if (params.item?.type === "agentMessage" && turn && !turn.text && params.item.text) {
        turn.text = params.item.text;
      }
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

  #recordItemStarted(turnId, item = {}) {
    const event = describeEvent(item, this.config.cwd);
    if (event) this.#upsertEvent(turnId, `item:${item.id || item.type}`, { ...event, status: "running" });
    if (item.type === "commandExecution") {
      for (const name of extractSkillNames(item.command)) {
        this.#upsertEvent(turnId, `skill:${item.id}:${name}`, {
          kind: "skill",
          title: `Skill · ${name}`,
          detail: "已读取并启用该 Skill 的执行规范",
          status: "running",
        });
      }
    }
  }

  #recordItemCompleted(turnId, item = {}) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    const event = turn.events.find((entry) => entry.key === `item:${item.id || item.type}`);
    if (event) {
      event.status = item.status || (item.success === false ? "failed" : "completed");
      event.durationMs = item.durationMs ?? null;
      event.updatedAt = Date.now();
      if (item.type === "reasoning" && Array.isArray(item.summary) && item.summary.length) {
        event.detail = safeDetail(item.summary.join("\n"), this.config.cwd, 2_000);
      }
    }
    for (const skill of extractSkillNames(item.command)) {
      const skillEvent = turn.events.find((entry) => entry.key === `skill:${item.id}:${skill}`);
      if (skillEvent) {
        skillEvent.status = "completed";
        skillEvent.updatedAt = Date.now();
      }
    }
  }

  #appendReasoningSummary(params) {
    const key = `reasoning:${params.itemId}:${params.summaryIndex}`;
    const turn = this.turns.get(params.turnId);
    if (!turn) return;
    const current = turn.events.find((event) => event.key === key);
    const detail = safeDetail(`${current?.detail || ""}${params.delta || ""}`, this.config.cwd, 2_000);
    this.#upsertEvent(params.turnId, key, {
      kind: "reasoning",
      title: "推理摘要",
      detail,
      status: "running",
    });
    this.#updateTurn(params.turnId, "thinking", previewActivity("正在推理", detail));
  }

  #recordPlan(params) {
    const symbols = { completed: "✓", inProgress: "→", pending: "○" };
    const detail = (params.plan || [])
      .map((item) => `${symbols[item.status] || "○"} ${item.step}`)
      .join("\n");
    this.#upsertEvent(params.turnId, "turn-plan", {
      kind: "plan",
      title: "执行计划",
      detail: safeDetail(detail || params.explanation || "正在规划任务", this.config.cwd, 2_000),
      status: "running",
    });
    this.#updateTurn(params.turnId, "planning", "正在更新执行计划");
  }

  #upsertEvent(turnId, key, patch) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    const now = Date.now();
    const current = turn.events.find((event) => event.key === key);
    if (current) Object.assign(current, patch, { updatedAt: now });
    else {
      turn.events.push({ key, startedAt: now, updatedAt: now, ...patch });
      if (turn.events.length > 50) turn.events.splice(0, turn.events.length - 50);
    }
    turn.lastEventAt = now;
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

function describeItem(item = {}, cwd = "") {
  switch (item.type) {
    case "reasoning": return { phase: "thinking", activity: "正在推理" };
    case "plan": return { phase: "planning", activity: "正在规划任务" };
    case "agentMessage": return { phase: "responding", activity: "正在组织回复" };
    case "commandExecution": return { phase: "tool", activity: previewActivity("正在执行命令", safeDetail(item.command, cwd, 120)) };
    case "fileChange": return { phase: "editing", activity: "正在修改本地文件" };
    case "mcpToolCall": return { phase: "tool", activity: previewActivity("正在调用工具", item.tool) };
    case "dynamicToolCall": return { phase: "tool", activity: previewActivity("正在调用工具", item.tool) };
    case "collabAgentToolCall": return { phase: "tool", activity: "正在协同处理任务" };
    case "webSearch": return { phase: "searching", activity: previewActivity("正在搜索", safeDetail(item.query, cwd, 120)) };
    case "imageGeneration": return { phase: "tool", activity: "正在生成图片" };
    default: return { phase: "working", activity: "Codex 正在处理" };
  }
}

function describeEvent(item, cwd) {
  switch (item.type) {
    case "reasoning":
      return { kind: "reasoning", title: "推理", detail: "等待推理摘要" };
    case "plan":
      return { kind: "plan", title: "规划", detail: safeDetail(item.text || "正在规划任务", cwd) };
    case "commandExecution":
      return { kind: "command", title: "执行命令", detail: safeDetail(item.command, cwd) };
    case "fileChange":
      return { kind: "file", title: "修改文件", detail: describeFileChanges(item, cwd) };
    case "mcpToolCall":
      return { kind: "tool", title: `MCP · ${item.server || "unknown"}/${item.tool || "unknown"}`, detail: "调用 MCP 工具" };
    case "dynamicToolCall":
      return { kind: "tool", title: `工具 · ${item.namespace ? `${item.namespace}/` : ""}${item.tool || "unknown"}`, detail: "调用动态工具" };
    case "collabAgentToolCall":
      return { kind: "tool", title: "协同 Agent", detail: safeDetail(item.tool || item.action || "协同处理任务", cwd) };
    case "webSearch":
      return { kind: "tool", title: "网页搜索", detail: safeDetail(item.query || "正在搜索", cwd) };
    case "imageGeneration":
      return { kind: "tool", title: "图片生成", detail: "正在生成图片" };
    default:
      return null;
  }
}

function describeFileChanges(item, cwd) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (!changes.length) return "正在修改本地文件";
  return safeDetail(changes.slice(0, 8).map((change) => change.path || change.file || change.kind).filter(Boolean).join("\n"), cwd);
}

function extractSkillNames(command) {
  if (typeof command !== "string") return [];
  const names = new Set();
  for (const match of command.matchAll(/\/skills\/([^/\s'"`]+)\/SKILL\.md/gi)) names.add(match[1]);
  for (const match of command.matchAll(/skill:\/\/[^/\s'"`]+\/([^/\s'"`]+)/gi)) names.add(match[1]);
  return [...names].slice(0, 8);
}

function safeDetail(value, cwd, maxChars = 800) {
  if (!value) return "";
  let text = String(value);
  if (cwd) text = text.split(cwd).join(".");
  text = text
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\/home\/[^/\s]+/g, "~")
    .replace(/((?:password|passwd|token|secret|authorization|api[_-]?key)\s*[=:]\s*)['"]?[^\s'";]+['"]?/gi, "$1[REDACTED]")
    .replace(/(--?(?:password|passwd|token|secret|authorization|api[_-]?key)\s+)['"]?[^\s'";]+['"]?/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
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
