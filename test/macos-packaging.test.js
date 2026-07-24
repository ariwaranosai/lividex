import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALLER = path.join(ROOT, "scripts", "macos-menubar.sh");
const MENU_BAR = path.join(ROOT, "macos", "LivisCodexMenuBar.swift");

test("macOS installer is valid shell and installs a login LaunchAgent", async () => {
  execFileSync("zsh", ["-n", INSTALLER]);
  const source = await readFile(INSTALLER, "utf8");
  assert.match(source, /RunAtLoad -bool true/);
  assert.match(source, /KeepAlive\.SuccessfulExit -bool false/);
  assert.match(source, /launchctl bootstrap/);
  assert.match(source, /LIVIS_CODEX_HOME/);
  assert.match(source, /src\/cli\.js" setup --cwd/);
  assert.match(source, /dashboard_url/);
});

test("menu bar checks auth, controls the gateway, and exposes login", async () => {
  const source = await readFile(MENU_BAR, "utf8");
  assert.match(source, /refreshToken/);
  assert.match(source, /appendingPathComponent\("api\/status"\)/);
  assert.match(source, /livis\["relayReady"\]/);
  assert.match(source, /showLoginReminder/);
  assert.match(source, /@objc private func openDashboard/);
  assert.match(source, /NSMenuItem\(title: "重启后台进程", action: #selector\(restartGateway\)/);
  assert.match(source, /@objc private func restartGateway/);
  assert.match(source, /gatewayRestartPending = true/);
  assert.match(source, /process\.terminate\(\)/);
  assert.match(source, /self\.startGatewayIfNeeded\(\)/);
  assert.match(source, /@objc private func startLogin/);
  assert.match(source, /attributes: \[\.foregroundColor: NSColor\.labelColor\]/);
  assert.match(source, /systemSymbolName: "link"/);
  assert.match(source, /SymbolConfiguration\(pointSize: 16, weight: \.semibold\)/);
  assert.match(source, /SymbolConfiguration\(paletteColors: \[color\]\)/);
  assert.match(source, /image\.isTemplate = false/);
});
