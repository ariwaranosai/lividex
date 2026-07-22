import test from "node:test";
import assert from "node:assert/strict";
import { DashboardServer } from "../src/dashboard-server.js";

test("DashboardServer serves the UI and live JSON status", async () => {
  const dashboard = new DashboardServer(
    { enabled: true, host: "127.0.0.1", port: 0 },
    {
      snapshot: () => ({ now: 123, gateway: { jobs: [{ id: "job-1", status: "running" }] } }),
      log: { log() {} },
    },
  );
  try {
    const url = await dashboard.start();
    const status = await fetch(`${url}/api/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      now: 123,
      gateway: { jobs: [{ id: "job-1", status: "running" }] },
    });
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Livis Codex Console/);
    assert.match(html, /当前线程/);
    assert.match(html, /已用时/);
    assert.match(html, /实时执行轨迹/);
    assert.match(html, /推理摘要，不含隐藏思维链/);
    assert.match(html, /<h2>任务结果<\/h2>/);
    assert.match(html, /<th>结果<\/th>/);
    assert.match(html, /RESULT_PAGE_SIZE = 10/);
    assert.match(html, /slice\(0, 50\)/);
    assert.doesNotMatch(html, /状态 \/ 阶段/);
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  } finally {
    await dashboard.stop();
  }
});
