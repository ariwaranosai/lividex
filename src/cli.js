#!/usr/bin/env node
import { access, constants as fsConstants, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { login, logout, getAccessToken } from "./auth.js";
import { CodexClient } from "./codex-client.js";
import { DEFAULT_CONFIG } from "./constants.js";
import { Gateway } from "./gateway.js";
import { LivisClient } from "./livis-client.js";
import { DashboardServer } from "./dashboard-server.js";
import {
  StateStore,
  ensureConfig,
  loadConfig,
  loadOrCreateAgentId,
  loadOrCreateDeviceId,
  statePaths,
  updateConfig,
} from "./storage.js";

const command = process.argv[2] || "help";
const paths = statePaths();

try {
  if (command === "setup") await setup();
  else if (command === "login") await loginCommand();
  else if (command === "logout") await logoutCommand();
  else if (command === "start") await startCommand();
  else if (command === "agent-id") console.log(await loadOrCreateAgentId(paths));
  else if (command === "doctor") await doctor();
  else if (command === "help" || command === "--help" || command === "-h") usage();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(`livis-codex: ${error.message}`);
  process.exitCode = 1;
}

async function setup() {
  const cwdArg = valueAfter("--cwd");
  const cwd = path.resolve(cwdArg || process.cwd());
  await mkdir(cwd, { recursive: true });
  const config = await ensureConfig(paths, { codex: { ...DEFAULT_CONFIG.codex, cwd } });
  const agentId = await loadOrCreateAgentId(paths);
  await loadOrCreateDeviceId(paths);
  console.log(`Config: ${paths.config}`);
  console.log(`Codex cwd: ${config.codex.cwd}`);
  console.log(`Agent ID: ${agentId}`);
  console.log("Next: livis-codex login");
}

async function loginCommand() {
  const config = await loadConfig(paths);
  await login(config.livis, paths, { openBrowser: !process.argv.includes("--no-browser") });
  console.log(`Agent ID: ${await loadOrCreateAgentId(paths)}`);
  console.log("Bind this Agent ID in the Livis app, then run: livis-codex start");
}

async function logoutCommand() {
  const config = await loadConfig(paths);
  await logout(config.livis, paths);
  console.log("Logged out and cleared the local Livis token.");
}

async function startCommand() {
  const config = await loadConfig(paths);
  const identity = {
    agentId: await loadOrCreateAgentId(paths),
    deviceId: await loadOrCreateDeviceId(paths),
    nodeName: "我的电脑",
  };
  const codex = new CodexClient(config.codex);
  const livis = new LivisClient(
    { ...config.livis, ...config.gateway },
    identity,
    () => getAccessToken(config.livis, paths),
  );
  const state = new StateStore(paths.state);
  const gateway = new Gateway({
    livis,
    codex,
    state,
    maxInputChars: config.gateway.maxInputChars,
  });
  const startedAt = Date.now();
  const dashboard = new DashboardServer(config.dashboard, {
    snapshot: () => ({
      now: Date.now(),
      startedAt,
      agentId: identity.agentId,
      livis: livis.status(),
      codex: {
        ...codex.status(),
        sandbox: config.codex.sandbox,
        approvalsReviewer: config.codex.approvalsReviewer,
      },
      gateway: gateway.status(),
    }),
    updateSettings: async (settings) => {
      const normalized = codex.validateSettings(settings);
      await updateConfig(paths, { codex: normalized });
      return codex.updateSettings(normalized, {
        threadIds: Object.values(state.value.threads),
      });
    },
  });
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, stopping...`);
    await dashboard.stop();
    await gateway.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  try {
    await gateway.start();
    await dashboard.start();
  } catch (error) {
    await dashboard.stop().catch(() => {});
    await gateway.stop().catch(() => {});
    throw error;
  }
  console.log(`Livis ↔ Codex gateway running. Agent ID: ${identity.agentId}`);
}

async function doctor() {
  const config = await loadConfig(paths);
  const checks = [];
  checks.push(["config", await canRead(paths.config), paths.config]);
  checks.push(["tokens", Boolean((await safeJson(paths.tokens))?.refreshToken), paths.tokens]);
  checks.push(["codex cwd", await canRead(config.codex.cwd), config.codex.cwd]);
  const codex = spawnSync(config.codex.binary, ["app-server", "--help"], { encoding: "utf8" });
  checks.push(["codex app-server", codex.status === 0, config.codex.binary]);
  checks.push(["Node >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.version]);
  for (const [name, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

function usage() {
  console.log(`Usage: livis-codex <command>\n\nCommands:\n  setup [--cwd PATH]  Create config and IDs\n  login [--no-browser] Authenticate with Livis IDaaS\n  start               Run the gateway\n  logout              Revoke and clear Livis credentials\n  agent-id            Print the Agent ID\n  doctor              Validate the local setup`);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function canRead(file) {
  try {
    await access(file, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
