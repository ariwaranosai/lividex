import test from "node:test";
import assert from "node:assert/strict";
import { decodeCommand } from "../src/gateway.js";
import { mergeConfig } from "../src/storage.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

test("decodeCommand accepts the Livis nested data envelope", () => {
  const command = decodeCommand({
    payload: {
      from_node_id: "phone-1",
      from_node_type: "app",
      data: JSON.stringify({ type: "exec", content: "hello" }),
    },
  });
  assert.deepEqual(command, {
    type: "exec",
    content: "hello",
    fromNodeId: "phone-1",
    fromNodeType: "app",
  });
});

test("decodeCommand rejects malformed data", () => {
  assert.equal(decodeCommand({ payload: { data: "{" } }), null);
});

test("mergeConfig preserves nested defaults", () => {
  const result = mergeConfig(DEFAULT_CONFIG, { codex: { model: "gpt-test" } });
  assert.equal(result.codex.model, "gpt-test");
  assert.equal(result.codex.sandbox, "workspace-write");
  assert.equal(result.codex.approvalsReviewer, "auto_review");
  assert.equal(result.livis.scope, "super");
});
