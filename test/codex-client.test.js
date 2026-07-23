import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { CodexClient } from "../src/codex-client.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0, "SIGTERM");
  return child;
}

test("CodexClient aggregates final answer deltas", async () => {
  const child = fakeChild();
  const client = new CodexClient(
    { binary: "codex", cwd: process.cwd(), reasoningEffort: "low" },
    { spawnFn: () => child, log: { warn() {} } },
  );
  client.child = child;
  const turnPromise = client.runTurn("thread-1", "hello", { jobId: "job-1" });
  const request = JSON.parse(await readLine(child.stdin));
  client.handleLine(JSON.stringify({ id: request.id, result: { turn: { id: "turn-1" } } }));
  await new Promise((resolve) => setImmediate(resolve));
  client.handleLine(JSON.stringify({
    method: "item/started",
    params: {
      turnId: "turn-1",
      item: {
        id: "item-command",
        type: "commandExecution",
        command: "cat /home/node/.codex/skills/forge-model/SKILL.md && forge job list --status running --token supersecret",
      },
    },
  }));
  assert.match(client.status().activeTurns[0].activity, /forge job list/);
  assert.equal(client.status().activeTurns[0].phase, "tool");
  assert.equal(client.status().activeTurns[0].events[0].kind, "command");
  assert.doesNotMatch(JSON.stringify(client.status()), /supersecret|\/home\/node/);
  assert.match(client.status().activeTurns[0].events[0].detail, /--token \[REDACTED\]/);
  assert.deepEqual(client.status().activeTurns[0].events[1], {
    startedAt: client.status().activeTurns[0].events[1].startedAt,
    updatedAt: client.status().activeTurns[0].events[1].updatedAt,
    kind: "skill",
    title: "Skill · forge-model",
    detail: "已读取并启用该 Skill 的执行规范",
    status: "running",
  });
  client.handleLine(JSON.stringify({
    method: "item/reasoning/summaryTextDelta",
    params: { turnId: "turn-1", itemId: "reasoning-1", summaryIndex: 0, delta: "先确认正在运行的任务，" },
  }));
  client.handleLine(JSON.stringify({
    method: "item/reasoning/summaryTextDelta",
    params: { turnId: "turn-1", itemId: "reasoning-1", summaryIndex: 0, delta: "再汇总结果。" },
  }));
  client.handleLine(JSON.stringify({
    method: "item/reasoning/textDelta",
    params: { turnId: "turn-1", itemId: "reasoning-1", contentIndex: 0, delta: "hidden-private-reasoning" },
  }));
  const reasoning = client.status().activeTurns[0].events.find((event) => event.kind === "reasoning");
  assert.equal(reasoning.detail, "先确认正在运行的任务，再汇总结果。");
  assert.doesNotMatch(JSON.stringify(client.status()), /hidden-private-reasoning/);
  client.handleLine(JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "hel" } }));
  assert.equal(client.status().activeTurns[0].phase, "responding");
  client.handleLine(JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "lo" } }));
  client.handleLine(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } }));
  assert.deepEqual(await turnPromise, { text: "hello", turnId: "turn-1" });
  assert.deepEqual(client.status().activeTurns, []);
});

test("CodexClient exposes thread wait flags", () => {
  const child = fakeChild();
  const client = new CodexClient(
    { binary: "codex", cwd: process.cwd() },
    { spawnFn: () => child, log: { warn() {} } },
  );
  client.child = child;
  client.handleLine(JSON.stringify({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  }));
  assert.deepEqual(client.status().threadStatuses[0], {
    threadId: "thread-1",
    status: "active",
    waitingOnApproval: true,
    waitingOnUserInput: false,
    updatedAt: client.status().threadStatuses[0].updatedAt,
  });
});

test("CodexClient starts threads with the configured auto reviewer", async () => {
  const child = fakeChild();
  const client = new CodexClient(
    {
      binary: "codex",
      cwd: process.cwd(),
      model: "gpt-5.6-sol",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      baseInstructions: "test",
    },
    { spawnFn: () => child, log: { warn() {} } },
  );
  client.child = child;
  const threadPromise = client.createThread();
  const request = JSON.parse(await readLine(child.stdin));
  assert.equal(request.method, "thread/start");
  assert.equal(request.params.model, "gpt-5.6-sol");
  assert.equal(request.params.approvalPolicy, "on-request");
  assert.equal(request.params.approvalsReviewer, "auto_review");
  client.handleLine(JSON.stringify({ id: request.id, result: { thread: { id: "thread-1" } } }));
  assert.equal(await threadPromise, "thread-1");
});

test("CodexClient fails closed if an approval request reaches the gateway", async () => {
  const child = fakeChild();
  const client = new CodexClient(
    { binary: "codex", cwd: process.cwd() },
    { spawnFn: () => child, log: { warn() {} } },
  );
  client.child = child;
  client.handleLine(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }));
  const response = JSON.parse(await readLine(child.stdin));
  assert.deepEqual(response, { id: 99, result: { decision: "decline" } });
});

test("CodexClient loads available models and updates existing threads", async () => {
  const child = fakeChild();
  const client = new CodexClient(
    {
      binary: "codex",
      cwd: process.cwd(),
      model: "gpt-old",
      reasoningEffort: "medium",
    },
    { spawnFn: () => child, log: { warn() {} } },
  );
  client.child = child;
  const modelsPromise = client.refreshModels();
  const listRequest = JSON.parse(await readLine(child.stdin));
  assert.equal(listRequest.method, "model/list");
  client.handleLine(JSON.stringify({
    id: listRequest.id,
    result: {
      data: [{
        id: "gpt-new",
        model: "gpt-new",
        displayName: "GPT New",
        description: "test model",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "balanced" },
          { reasoningEffort: "high", description: "deep" },
        ],
      }],
      nextCursor: null,
    },
  }));
  await modelsPromise;
  assert.equal(client.status().models[0].model, "gpt-new");

  client.knownThreads.add("thread-1");
  const updatePromise = client.updateSettings({ model: "gpt-new", reasoningEffort: "high" });
  const updateRequest = JSON.parse(await readLine(child.stdin));
  assert.equal(updateRequest.method, "thread/settings/update");
  assert.deepEqual(updateRequest.params, {
    threadId: "thread-1",
    model: "gpt-new",
    effort: "high",
  });
  client.handleLine(JSON.stringify({ id: updateRequest.id, result: {} }));
  assert.deepEqual(await updatePromise, {
    model: "gpt-new",
    reasoningEffort: "high",
    updatedThreads: 1,
    failedThreads: 0,
  });
  assert.equal(client.status().reasoningEffort, "high");
  assert.throws(
    () => client.validateSettings({ model: "gpt-new", reasoningEffort: "ultra" }),
    /不支持思考强度/,
  );
});

function readLine(stream) {
  return new Promise((resolve) => {
    stream.once("data", (chunk) => resolve(String(chunk).trim()));
  });
}
