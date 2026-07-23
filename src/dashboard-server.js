import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX = path.join(ROOT, "..", "public", "index.html");

export class DashboardServer {
  constructor(config, { snapshot, updateSettings, indexFile = DEFAULT_INDEX, log = console } = {}) {
    this.config = config;
    this.snapshot = snapshot;
    this.updateSettings = updateSettings;
    this.indexFile = indexFile;
    this.log = log;
    this.server = null;
    this.url = null;
  }

  async start() {
    if (!this.config.enabled || this.server) return this.url;
    const index = await readFile(this.indexFile);
    this.server = createServer((request, response) => {
      this.#handle(request, response, index).catch((error) => {
        this.log.error?.(`[dashboard] request failed: ${error.stack || error}`);
        send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: "Internal Server Error" }));
      });
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

  async #handle(request, response, index) {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/status") {
      return send(response, 200, "application/json; charset=utf-8", JSON.stringify(this.snapshot()));
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      if (!this.updateSettings) {
        return send(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "Settings are unavailable" }));
      }
      if (!sameOrigin(request)) {
        return send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Cross-origin request denied" }));
      }
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        return send(response, 415, "application/json; charset=utf-8", JSON.stringify({ error: "Content-Type must be application/json" }));
      }
      try {
        const settings = JSON.parse(await readBody(request, 4_096));
        const updated = await this.updateSettings(settings);
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify(updated));
      } catch (error) {
        const status = error.statusCode || 400;
        return send(response, status, "application/json; charset=utf-8", JSON.stringify({ error: error.message }));
      }
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(response, 200, "text/html; charset=utf-8", index, {
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
    }
    if (request.method !== "GET") {
      return send(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", { allow: "GET, POST" });
    }
    return send(response, 404, "text/plain; charset=utf-8", "Not Found");
  }
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
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
