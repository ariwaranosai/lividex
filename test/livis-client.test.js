import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { LivisClient } from "../src/livis-client.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  send() {}

  close() {
    this.readyState = 3;
  }
}

function createClient() {
  FakeWebSocket.instances = [];
  return new LivisClient(
    { wsUrl: "wss://example.test/ws", heartbeatMs: 30_000, reconnectMaxMs: 0 },
    { agentId: "agent-1", deviceId: "device-1", nodeName: "test" },
    async () => ({ accessToken: "access", refreshToken: "refresh" }),
    {
      WebSocketImpl: FakeWebSocket,
      log: { log() {}, warn() {}, error() {} },
    },
  );
}

test("LivisClient reconnects when websocket error is not followed by close", async () => {
  const client = createClient();
  await client.connect();
  const failedSocket = FakeWebSocket.instances[0];

  failedSocket.emit("error", { message: "network failed" });
  await delay(10);

  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.status().relayReady, false);
  assert.equal(client.status().lastClose.code, 1006);
  assert.match(client.status().lastClose.reason, /network failed/);
  client.stop();
});

test("LivisClient schedules only one reconnect when error and close both fire", async () => {
  const client = createClient();
  await client.connect();
  const failedSocket = FakeWebSocket.instances[0];

  failedSocket.emit("error", { message: "network failed" });
  failedSocket.emit("close", { code: 1006, reason: "closed" });
  await delay(10);

  assert.equal(FakeWebSocket.instances.length, 2);
  client.stop();
});
