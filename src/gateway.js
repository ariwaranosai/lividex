export class Gateway {
  constructor({ livis, codex, state, maxInputChars = 100_000, log = console }) {
    this.livis = livis;
    this.codex = codex;
    this.state = state;
    this.maxInputChars = maxInputChars;
    this.log = log;
    this.nodeQueues = new Map();
    this.active = new Map();
    this.codex.on("turnStatus", (status) => this.#turnStatus(status));
  }

  async start() {
    await this.state.load();
    await this.state.markRunningJobsInterrupted();
    await this.state.pruneJobs();
    await this.codex.start();
    this.livis.on("command", (message) => this.#receive(message));
    this.livis.on("cancel", (message) => this.#cancel(message));
    this.livis.on("resultAck", (message) => this.#resultAck(message));
    await this.livis.connect();
  }

  async stop() {
    this.livis.stop();
    await this.codex.stop();
  }

  status() {
    const codexStatus = this.codex.status();
    const jobs = Object.entries(this.state.value.jobs)
      .map(([id, job]) => ({
        id,
        status: job.status,
        nodeId: job.nodeId || null,
        updatedAt: job.updatedAt || null,
        receivedAt: job.receivedAt || null,
        startedAt: job.startedAt || null,
        completedAt: job.completedAt || null,
        durationMs: job.durationMs || null,
        totalDurationMs: job.totalDurationMs || null,
        phase: job.phase || null,
        activity: job.activity || null,
        threadId: job.threadId || null,
        turnId: job.turnId || null,
        inputPreview: textPreview(job.input),
        resultPreview: resultPreview(job.result),
      }))
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      .slice(0, 50);
    const activeByThread = new Map(codexStatus.activeTurns.map((turn) => [turn.threadId, turn]));
    const statusByThread = new Map(codexStatus.threadStatuses.map((thread) => [thread.threadId, thread]));
    const threads = Object.entries(this.state.value.threads).map(([nodeId, threadId]) => ({
      nodeId,
      threadId,
      ...statusByThread.get(threadId),
      status: activeByThread.has(threadId) ? "active" : (statusByThread.get(threadId)?.status || "idle"),
      activeTurn: activeByThread.get(threadId) || null,
    }));
    return {
      activeCount: this.active.size,
      queuedCount: jobs.filter((job) => job.status === "queued").length,
      queuedNodeCount: this.nodeQueues.size,
      threadCount: Object.keys(this.state.value.threads).length,
      threads,
      jobs,
    };
  }

  #receive(message) {
    this.livis.ack(message);
    const jobId = message.metadata?.job_id;
    const decoded = decodeCommand(message);
    if (!jobId || !decoded) return;
    const previous = this.state.getJob(jobId);
    if (previous?.result) {
      this.livis.sendResult(jobId, previous.result);
      return;
    }
    const nodeId = decoded.fromNodeId;
    const prior = this.nodeQueues.get(nodeId) || Promise.resolve();
    decoded.receivedAt = Date.now();
    const queued = this.state.setJob(jobId, {
      status: "queued",
      phase: "queued",
      activity: "等待同一节点的前序任务",
      nodeId,
      input: decoded.content,
      receivedAt: decoded.receivedAt,
    });
    const next = queued.then(() => prior).then(() => this.#execute(jobId, decoded)).catch((error) => {
      this.log.error(`[gateway] job ${jobId} failed: ${error.stack || error}`);
    });
    this.nodeQueues.set(nodeId, next);
    next.finally(() => {
      if (this.nodeQueues.get(nodeId) === next) this.nodeQueues.delete(nodeId);
    });
  }

  async #execute(jobId, command) {
    if (command.type !== "exec") {
      await this.#finish(jobId, `Unsupported Livis command type: ${command.type}`);
      return;
    }
    if (!command.content || command.content.length > this.maxInputChars) {
      const text = command.content ? `Input too large (max ${this.maxInputChars} characters).` : "Empty request.";
      await this.#finish(jobId, text);
      return;
    }
    await this.state.setJob(jobId, {
      status: "running",
      phase: "starting",
      activity: "正在启动 Codex 对话",
      nodeId: command.fromNodeId,
      input: command.content,
      receivedAt: command.receivedAt,
      startedAt: Date.now(),
    });
    let threadId = this.state.getThread(command.fromNodeId);
    if (threadId) {
      try {
        await this.codex.resumeThread(threadId);
      } catch {
        threadId = null;
      }
    }
    if (!threadId) {
      threadId = await this.codex.createThread();
      await this.state.setThread(command.fromNodeId, threadId);
    }
    await this.state.setJob(jobId, { threadId, phase: "thinking", activity: "正在推理" });
    const active = { threadId, turnId: null, cancelled: false };
    this.active.set(jobId, active);
    try {
      const result = await this.codex.runTurn(threadId, command.content, {
        jobId,
        onTurnStarted: (turnId) => {
          active.turnId = turnId;
          this.state.setJob(jobId, {
            turnId,
            turnStartedAt: Date.now(),
            phase: "thinking",
            activity: "正在推理",
          }).catch((error) => this.log.warn(`[gateway] cannot persist turn status: ${error.message}`));
          if (active.cancelled) this.codex.interrupt(active.threadId, turnId).catch(() => {});
        },
      });
      if (active.cancelled) return;
      await this.#finish(jobId, result.text || "Codex returned an empty response.");
    } catch (error) {
      if (!active.cancelled) await this.#finish(jobId, `Error: ${error.message}`);
    } finally {
      this.active.delete(jobId);
    }
  }

  async #finish(jobId, text) {
    const result = JSON.stringify({ text });
    const job = this.state.getJob(jobId) || {};
    const codexCompletedAt = Date.now();
    await this.state.setJob(jobId, {
      status: "ready",
      phase: "delivering",
      activity: "Codex 已完成，正在回传 Livis",
      codexCompletedAt,
      durationMs: job.startedAt ? codexCompletedAt - job.startedAt : null,
      result,
    });
    this.livis.sendResult(jobId, result);
  }

  async #cancel(message) {
    this.livis.ackCancel(message);
    const jobId = message.metadata?.job_id;
    const active = this.active.get(jobId);
    if (active) active.cancelled = true;
    if (active?.turnId) {
      await this.codex.interrupt(active.threadId, active.turnId).catch(() => {});
    }
    if (jobId) await this.state.setJob(jobId, {
      status: "cancelled",
      phase: "cancelled",
      activity: "任务已取消",
      completedAt: Date.now(),
    });
  }

  async #resultAck(message) {
    const jobId = message.payload?.ref_msg_id || message.metadata?.job_id;
    if (jobId) {
      const job = this.state.getJob(jobId) || {};
      const completedAt = Date.now();
      await this.state.setJob(jobId, {
        status: "completed",
        phase: "completed",
        activity: "Livis 已确认收到结果",
        completedAt,
        totalDurationMs: job.receivedAt ? completedAt - job.receivedAt : null,
      });
    }
  }

  #turnStatus(status) {
    if (!status.jobId) return;
    this.state.setJob(status.jobId, {
      phase: status.phase,
      activity: status.activity,
      lastEventAt: status.lastEventAt,
    }).catch((error) => this.log.warn(`[gateway] cannot persist Codex status: ${error.message}`));
  }
}

function resultPreview(result) {
  if (!result) return "";
  try {
    const parsed = JSON.parse(result);
    return String(parsed?.text || result).slice(0, 500);
  } catch {
    return String(result).slice(0, 500);
  }
}

function textPreview(value) {
  return value ? String(value).slice(0, 1_000) : "";
}

export function decodeCommand(message) {
  const payload = message?.payload;
  let data = payload?.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  return {
    type: data.type || "message",
    content: typeof data.content === "string" ? data.content : "",
    fromNodeId: payload.from_node_id || "unknown",
    fromNodeType: payload.from_node_type || null,
  };
}
