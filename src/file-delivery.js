import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CLIENT_NAME } from "./constants.js";

const TYPES = {
  pdf: "application/pdf", html: "text/html", htm: "text/html",
  md: "text/markdown", markdown: "text/markdown", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 5;

export async function createDeliveryDirectory(cwd) {
  const root = path.join(await realpath(cwd), ".livis-delivery");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new Error("Delivery directory must not be a symlink");
  return mkdtemp(path.join(root, "job-"));
}

export function deliveryInstructions(directory) {
  return `\n\n[Livis file delivery] If the user explicitly asks to receive a file, create or copy the requested document into ${directory}. Only PDF, HTML, Markdown, DOC and DOCX are supported. At the very end of your final reply put one line in this exact format: <livis-files>["filename.pdf"]</livis-files> (JSON array of base filenames, up to 5). Do not include this line unless files should be delivered. Do not claim a file was delivered; delivery occurs after your response.`;
}

export function parseDelivery(text) {
  const match = text.match(/(?:^|\n)<livis-files>([^\n]*)<\/livis-files>\s*$/);
  if (!match) return { text, names: [] };
  let names;
  try { names = JSON.parse(match[1]); } catch { throw new Error("Invalid file delivery list"); }
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_FILES ||
      names.some((name) => typeof name !== "string" || !name || name === "." || name === ".." || path.basename(name) !== name || name.includes("\\") || name.includes("\0")) ||
      new Set(names).size !== names.length) throw new Error("Invalid file delivery filenames");
  return { text: text.slice(0, match.index).trim(), names };
}

export async function uploadDeliveryFile({ directory, name, jobId, tokenProvider, fetchImpl = fetch, signal }) {
  if (typeof name !== "string" || path.basename(name) !== name || name.includes("\\") || name === "." || name === "..") throw new Error("Invalid filename");
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = TYPES[ext];
  if (!mime) throw new Error(`Unsupported file type: ${name}`);
  const root = await realpath(directory);
  if (root !== directory) throw new Error("Delivery directory changed");
  const handle = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  let buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error(`File must be a regular file no larger than 100 MiB: ${name}`);
    buffer = await handle.readFile();
    if (buffer.length > MAX_BYTES) throw new Error(`File too large: ${name}`);
  } finally { await handle.close(); }
  const { accessToken } = await tokenProvider();
  if (!accessToken) throw new Error("No Livis access token");
  const base = name.slice(0, -(ext.length + 1));
  const params = new URLSearchParams({ client: CLIENT_NAME, job_id: jobId, msg_id: randomUUID(), file_size: String(buffer.length), file_name: base, file_suffix: ext, file_type: mime });
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), name);
  const response = await fetchImpl(`https://livis-pc-kit-gateway.livis.com/api/v1/files/upload?${params}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form, signal });
  if (!response.ok) throw new Error(`File upload failed (HTTP ${response.status})`);
  const data = await response.json();
  if (typeof data.objectKey !== "string" || !data.objectKey) throw new Error("File upload response has no object key");
  const info = data.fileInfo || {};
  return { name: String(info.fileName ?? base), fileSuffix: String(info.fileSuffix ?? ext), objectKey: data.objectKey,
    fileSize: Number(info.fileSize ?? data.fileSize ?? buffer.length), fileType: String(info.fileType ?? mime),
    file_path: data.objectKey.includes("/") ? `/${data.objectKey.split("/").slice(1, -1).join("/")}` : "/", expiresAt: Number(data.expiresAt ?? 0) };
}
