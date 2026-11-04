import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Gateway } from "../src/gateway.js";
import { VOICE_INSTRUCTIONS } from "../src/voice-prompt.js";

test("resumed Livis turns receive listening instructions alongside file delivery", async (t) => {
  const cwd = await mkdtemp(path.join(await realpath(os.tmpdir()), "livis-voice-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const codex = new EventEmitter();
  codex.config = { cwd };
  codex.start = async () => {};
  codex.resumeThread = async () => {};
  let prompt;
  codex.runTurn = async (_thread, text) => { prompt = text; return { text: "完成。" }; };
  const livis = new EventEmitter();
  livis.connect = async () => {};
  livis.ack = () => {};
  livis.sendResult = (_job, result) => livis.emit("sent", result);
  const jobs = {};
  const state = {
    value: { jobs, threads: { phone: "existing-thread" } },
    load: async () => {}, markRunningJobsInterrupted: async () => {}, pruneJobs: async () => {},
    getJob: (id) => jobs[id], getThread: (id) => state.value.threads[id],
    setJob: async (id, patch) => { jobs[id] = { ...jobs[id], ...patch }; },
  };
  const gateway = new Gateway({ livis, codex, state });
  await gateway.start();
  const sent = once(livis, "sent");
  livis.emit("command", { metadata: { job_id: "job" }, payload: { from_node_id: "phone", data: JSON.stringify({ type: "exec", content: "你好" }) } });
  const [result] = await sent;
  assert.ok(prompt.startsWith("你好"));
  assert.ok(prompt.includes(VOICE_INSTRUCTIONS));
  assert.match(prompt, /<livis-files>/);
  assert.deepEqual(JSON.parse(result), { text: "完成。" });
});
