import { spawn } from "node:child_process";
import { readJson, writeJsonAtomic } from "./storage.js";

function formBody(values) {
  return new URLSearchParams(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null),
  ).toString();
}

async function postForm(url, values) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(values),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function audienceToken(data, audience) {
  return data?.[audience] || data;
}

export async function login(config, paths, { openBrowser = true, log = console } = {}) {
  const device = await postForm(`${config.idpUrl}/aux`, {
    client_id: config.clientId,
    scope: `${config.scope} offline_access`,
    audience: config.audience,
    offline_access: "true",
  });
  const verificationUrl = device.verification_uri_complete || device.verification_uri;
  log.log(`Open: ${verificationUrl}`);
  if (device.user_code) log.log(`Code: ${device.user_code}`);
  if (openBrowser && verificationUrl) openUrl(verificationUrl);

  const intervalMs = Math.max(1, Number(device.interval || 5)) * 1000;
  const deadline = Date.now() + Math.max(30, Number(device.expires_in || 600)) * 1000;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    try {
      const raw = await postForm(`${config.idpUrl}/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: config.clientId,
      });
      const token = audienceToken(raw, config.audience);
      if (!token?.refresh_token) throw new Error("IDaaS response has no refresh_token");
      await writeJsonAtomic(paths.tokens, { refreshToken: token.refresh_token });
      log.log("Livis login successful.");
      return token;
    } catch (error) {
      const code = error.data?.error;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        await delay(5000);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Device login timed out");
}

export async function getAccessToken(config, paths) {
  const stored = await readJson(paths.tokens, null);
  if (!stored?.refreshToken) throw new Error("Not logged in. Run `livis-codex login`.");
  const raw = await postForm(`${config.idpUrl}/token`, {
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
  });
  const token = audienceToken(raw, config.audience);
  if (!token?.access_token) throw new Error("IDaaS response has no access_token");
  if (token.refresh_token && token.refresh_token !== stored.refreshToken) {
    await writeJsonAtomic(paths.tokens, { refreshToken: token.refresh_token });
  }
  return { accessToken: token.access_token, refreshToken: token.refresh_token || stored.refreshToken };
}

export async function logout(config, paths) {
  const stored = await readJson(paths.tokens, null);
  if (stored?.refreshToken) {
    try {
      await postForm(`${config.idpUrl}/revoke`, {
        token: stored.refreshToken,
        token_type_hint: "refresh_token",
        client_id: config.clientId,
      });
    } catch (error) {
      console.warn(`Token revoke failed; clearing local token anyway: ${error.message}`);
    }
  }
  await writeJsonAtomic(paths.tokens, {});
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
