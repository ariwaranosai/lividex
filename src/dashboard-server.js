import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX = path.join(ROOT, "..", "public", "index.html");

export class DashboardServer {
  constructor(config, { snapshot, indexFile = DEFAULT_INDEX, log = console } = {}) {
    this.config = config;
    this.snapshot = snapshot;
    this.indexFile = indexFile;
    this.log = log;
    this.server = null;
    this.url = null;
  }

  async start() {
    if (!this.config.enabled || this.server) return this.url;
    const index = await readFile(this.indexFile);
    this.server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "Method Not Allowed");
      if (url.pathname === "/api/status") {
        try {
          return send(response, 200, "application/json; charset=utf-8", JSON.stringify(this.snapshot()));
        } catch (error) {
          return send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: error.message }));
        }
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return send(response, 200, "text/html; charset=utf-8", index, {
          "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        });
      }
      return send(response, 404, "text/plain; charset=utf-8", "Not Found");
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, resolve);
    });
    const address = this.server.address();
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    this.url = `http://${host}:${address.port}`;
    this.log.log(`[dashboard] ${this.url}`);
    return this.url;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}
