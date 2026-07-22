import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CLIENT_NAME, NODE_TYPE } from "./constants.js";

export class LivisClient extends EventEmitter {
  constructor(config, identity, tokenProvider, { WebSocketImpl = globalThis.WebSocket, log = console } = {}) {
    super();
    if (!WebSocketImpl) throw new Error("Node.js 22+ is required (global WebSocket is unavailable)");
    this.config = config;
    this.identity = identity;
    this.tokenProvider = tokenProvider;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.socket = null;
    this.stopping = false;
    this.reconnectAttempt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.lastSocketOpenAt = null;
    this.lastMessageAt = null;
    this.lastMessageType = null;
    this.lastClose = null;
    this.relayReady = false;
  }

  async connect() {
    const { accessToken, refreshToken } = await this.tokenProvider();
    const url = `${this.config.wsUrl}?protocol_version=1`;
    this.log.log(`[livis] connecting to ${url}`);
    const socket = new this.WebSocketImpl(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.lastSocketOpenAt = Date.now();
      this.lastClose = null;
      this.sendRaw({
        type: "connect",
        metadata: this.metadata(randomUUID()),
        payload: {
          device_id: this.identity.deviceId,
          node_name: this.identity.nodeName,
          node_desc: `${NODE_TYPE} ${this.identity.nodeName}`,
          client: CLIENT_NAME,
          token: accessToken,
          refresh_token: refreshToken,
        },
      });
      this.#startHeartbeat();
      this.emit("connected");
    });
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("error", (event) => this.log.error(`[livis] websocket error: ${event.message || "unknown"}`));
    socket.addEventListener("close", (event) => {
      this.#stopHeartbeat();
      this.relayReady = false;
      this.lastClose = { code: event.code, reason: event.reason || "", at: Date.now() };
      this.log.warn(`[livis] disconnected (code=${event.code}${event.reason ? ` reason=${event.reason}` : ""})`);
      this.emit("disconnected", event);
      if (!this.stopping) this.#scheduleReconnect();
    });
  }

  stop() {
    this.stopping = true;
    this.#stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  status() {
    const names = ["connecting", "open", "closing", "closed"];
    return {
      socketState: names[this.socket?.readyState] || "disconnected",
      relayReady: this.relayReady,
      reconnectAttempt: this.reconnectAttempt,
      lastSocketOpenAt: this.lastSocketOpenAt,
      lastMessageAt: this.lastMessageAt,
      lastMessageType: this.lastMessageType,
      lastClose: this.lastClose,
    };
  }

  metadata(jobId = "") {
    return {
      msg_id: randomUUID(),
      job_id: jobId,
      agent_id: this.identity.agentId,
      device_id: this.identity.deviceId,
      timestamp: Date.now(),
    };
  }

  ack(message) {
    this.send("ack_send_message", {}, message.metadata?.job_id || randomUUID());
  }

  ackCancel(message) {
    this.send("ack_cancel_chat", {}, message.metadata?.job_id || randomUUID());
  }

  sendResult(jobId, data) {
    this.send("send_result", { data }, jobId);
  }

  send(type, payload, jobId = "") {
    this.sendRaw({ type, metadata: this.metadata(jobId), payload });
  }

  sendRaw(message) {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return false;
    const payload = {
      ...message,
      metadata: { ...message.metadata, client: message.metadata?.client || CLIENT_NAME },
      payload: { ...(message.payload || {}), nodeType: NODE_TYPE },
    };
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  #onMessage(raw) {
    try {
      const message = JSON.parse(String(raw));
      this.lastMessageAt = Date.now();
      this.lastMessageType = message.type || null;
      if (message.type === "connected") {
        this.relayReady = true;
        this.log.log("[livis] relay ready");
      } else if (message.type === "send_message") this.emit("command", message);
      else if (message.type === "cancel_chat") this.emit("cancel", message);
      else if (message.type === "token_expiring") this.#refreshToken();
      else if (message.type === "ack_send_result") this.emit("resultAck", message);
      else this.emit("message", message);
    } catch (error) {
      this.log.error(`[livis] invalid message: ${error.message}`);
    }
  }

  async #refreshToken() {
    try {
      const { accessToken, refreshToken } = await this.tokenProvider();
      this.send("token_refresh", { token: accessToken, refresh_token: refreshToken });
    } catch (error) {
      this.log.error(`[livis] token refresh failed: ${error.message}`);
      this.socket?.close();
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send("heartbeat", {}, randomUUID()), this.config.heartbeatMs);
  }

  #stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  #scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt++, this.config.reconnectMaxMs);
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    this.log.warn(`[livis] reconnecting in ${jittered}ms`);
    this.reconnectTimer = setTimeout(() => this.connect().catch((error) => {
      this.log.error(`[livis] reconnect failed: ${error.message}`);
      this.#scheduleReconnect();
    }), jittered);
  }
}
