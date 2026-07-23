import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEnvOverrides, StateStore, updateConfig } from "../src/storage.js";

test("Docker dashboard environment only overrides its listen address", () => {
  const original = {
    codex: { cwd: "/workspace" },
    dashboard: { enabled: true, host: "127.0.0.1", port: 8765 },
  };
  const configured = applyEnvOverrides(original, {
    LIVIS_CODEX_DASHBOARD_HOST: "0.0.0.0",
    LIVIS_CODEX_DASHBOARD_PORT: "9000",
  });
  assert.deepEqual(configured.dashboard, { enabled: true, host: "0.0.0.0", port: 9000 });
  assert.deepEqual(configured.codex, original.codex);
});

test("Docker dashboard environment rejects an invalid port", () => {
  assert.throws(
    () => applyEnvOverrides({ dashboard: { host: "127.0.0.1", port: 8765 } }, {
      LIVIS_CODEX_DASHBOARD_PORT: "70000",
    }),
    /between 1 and 65535/,
  );
});

test("updateConfig persists Codex settings without dropping other config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "livis-codex-config-"));
  const paths = { config: path.join(root, "config.json") };
  try {
    await writeFile(paths.config, JSON.stringify({
      livis: { clientId: "custom-client" },
      codex: { model: "gpt-old", reasoningEffort: "low", cwd: "/workspace" },
    }));
    const updated = await updateConfig(paths, {
      codex: { model: "gpt-new", reasoningEffort: "high" },
    });
    assert.equal(updated.livis.clientId, "custom-client");
    assert.equal(updated.codex.cwd, "/workspace");
    assert.equal(updated.codex.model, "gpt-new");
    assert.equal(updated.codex.reasoningEffort, "high");
    const saved = JSON.parse(await readFile(paths.config, "utf8"));
    assert.equal(saved.codex.model, "gpt-new");
    assert.equal(saved.codex.reasoningEffort, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
