import { CodexClient } from "../src/codex-client.js";

const cwd = process.argv[2] || process.cwd();
const client = new CodexClient({
  binary: process.env.CODEX_BINARY || "codex",
  cwd,
  model: "gpt-5.6-sol",
  sandbox: "read-only",
  approvalPolicy: "on-request",
  approvalsReviewer: "auto_review",
  reasoningEffort: "low",
  baseInstructions: "This is a transport smoke test. Follow the user request exactly.",
});

let threadId;
try {
  await client.start();
  threadId = await client.createThread();
  const result = await client.runTurn(threadId, "Reply with exactly: livis-codex-ok");
  if (result.text.trim() !== "livis-codex-ok") {
    throw new Error(`Unexpected Codex response: ${JSON.stringify(result.text)}`);
  }
  console.log(result.text.trim());
} finally {
  if (threadId) await client.request("thread/delete", { threadId }).catch(() => {});
  await client.stop();
}
