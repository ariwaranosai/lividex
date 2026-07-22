import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../src/storage.js";

test("StateStore marks jobs left running by an old process as interrupted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "livis-codex-state-"));
  const store = new StateStore(path.join(root, "state.json"));
  try {
    store.value.jobs = {
      running: { status: "running", updatedAt: 1 },
      completed: { status: "completed", updatedAt: 2 },
    };
    await store.save();
    await store.load();
    await store.markRunningJobsInterrupted();
    assert.equal(store.value.jobs.running.status, "interrupted");
    assert.equal(store.value.jobs.completed.status, "completed");
    assert.ok(store.value.jobs.running.updatedAt > 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("StateStore also interrupts queued and unacknowledged jobs after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "livis-codex-state-"));
  const store = new StateStore(path.join(root, "state.json"));
  try {
    store.value.jobs = {
      queued: { status: "queued" },
      ready: { status: "ready" },
    };
    await store.markRunningJobsInterrupted();
    assert.equal(store.getJob("queued").status, "interrupted");
    assert.equal(store.getJob("ready").status, "interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("StateStore keeps the newest 50 jobs without deleting active work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "livis-codex-state-"));
  const store = new StateStore(path.join(root, "state.json"));
  try {
    for (let index = 0; index < 50; index += 1) {
      store.value.jobs[`done-${index}`] = { status: "completed", updatedAt: index };
    }
    store.value.jobs.running = { status: "running", updatedAt: 0 };
    await store.setJob("newest", { status: "completed" });
    assert.equal(Object.keys(store.value.jobs).length, 50);
    assert.ok(store.value.jobs.running);
    assert.ok(store.value.jobs.newest);
    assert.equal(store.value.jobs["done-0"], undefined);
    assert.equal(store.value.jobs["done-1"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
