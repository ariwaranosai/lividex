import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeliveryDirectory, parseDelivery, uploadDeliveryFile } from "../src/file-delivery.js";

test("delivery parses only a final manifest and rejects unsafe paths", () => {
  assert.deepEqual(parseDelivery('done\n<livis-files>["a.md"]</livis-files>'), { text: "done", names: ["a.md"] });
  assert.deepEqual(parseDelivery('ordinary text'), { text: "ordinary text", names: [] });
  assert.throws(() => parseDelivery('<livis-files>["../secret.md"]</livis-files>'));
  assert.throws(() => parseDelivery('<livis-files>bad</livis-files>'));
});

test("uploads a staged document using the Livis multipart contract", async (t) => {
  const cwd = await mkdtemp(path.join(await import("node:fs/promises").then(x => x.realpath(os.tmpdir())), "livis-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = await createDeliveryDirectory(cwd);
  await writeFile(path.join(directory, "report.md"), "hello");
  let request;
  const result = await uploadDeliveryFile({ directory, name: "report.md", jobId: "job-1", tokenProvider: async () => ({ accessToken: "test-token" }), fetchImpl: async (url, options) => {
    request = { url: new URL(url), options };
    return new Response(JSON.stringify({ objectKey: "bucket/path/object", fileInfo: { fileName: "report", fileSize: 5 }, expiresAt: 123 }), { status: 200 });
  } });
  assert.equal(request.url.pathname, "/api/v1/files/upload");
  assert.equal(request.url.searchParams.get("job_id"), "job-1");
  assert.equal(request.url.searchParams.get("file_size"), "5");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(await request.options.body.get("file").text(), "hello");
  assert.deepEqual(result, { name: "report", fileSuffix: "md", objectKey: "bucket/path/object", fileSize: 5, fileType: "text/markdown", file_path: "/path", expiresAt: 123 });
  await symlink(path.join(cwd, "outside.md"), path.join(directory, "link.md"));
  await assert.rejects(uploadDeliveryFile({ directory, name: "link.md", jobId: "job-1", tokenProvider: async () => ({ accessToken: "x" }) }));
  await assert.rejects(uploadDeliveryFile({ directory, name: "file.png", jobId: "job-1", tokenProvider: async () => ({ accessToken: "x" }) }), /Unsupported/);
});
