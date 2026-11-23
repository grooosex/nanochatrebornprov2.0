import { unzipSync } from "fflate";
import { NAI_HOP_TIMEOUT_MS } from "./constants";
import { naiMigrationBase, normalizeNaiBase } from "./nai-base";

export type DirectV5 = {
  status_url?: string;
  file_url?: string;
  confirm_url?: string;
  confirmation_required?: boolean;
  sha256?: string;
  size_bytes?: number;
};

export type DirectHop = {
  image?: string;
  jobId?: string;
  statusUrl?: string;
  fileUrl?: string;
  pending?: boolean;
  v5?: DirectV5;
  baseUrl?: string;
};

export class DirectFileError extends Error {
  constructor() {
    super("图片地址手机读不到");
    this.name = "DirectFileError";
  }
}

type JobJson = {
  job_id?: string;
  id?: string;
  status?: string;
  image_url?: string;
  image?: string;
  error?: string;
  message?: string;
  code?: string;
  data?: JobJson;
  v5_delivery?: DirectV5;
};

function looksHtml(text: string) {
  const t = text.trimStart().slice(0, 80).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.startsWith("<?xml") || t.includes("<title>internal server error");
}

function isChallenge(text: string) {
  const t = text.slice(0, 500).toLowerCase();
  return t.includes("just a moment") || t.includes("cf-browser-verification") || t.includes("challenge-platform") || looksHtml(text);
}

function mapError(status: number, body: string) {
  if (isChallenge(body)) return "站点防护拦了这次生图，再试一次";
  let code = "";
  let msg = "";
  try {
    const j = JSON.parse(body) as { error?: string; message?: string; detail?: string; code?: string };
    code = String(j.code || j.error || "");
    msg = String(j.message || j.detail || (j.error && j.error !== code ? j.error : "") || "");
  } catch {
    if (body && !isChallenge(body)) msg = body.slice(0, 180);
  }
  if (code === "NOVELAI_V5_WEEKLY_QUOTA_EXCEEDED") return "NovelAI V5 本周额度已用完，请改用 V4.5 或等重置";
  if (code === "NOVELAI_V5_BACKEND_QUOTA_EXHAUSTED") return "V5 后端额度暂时耗尽，请稍后或改用 V4.5";
  if (status === 401 || status === 403) return "API Key 无效或档位不够，请重新填写";
  if (status === 402) return "中转站积分不足";
  if (status === 409) return "已有一张图正在生成，请等它完成后再试";
  if (status === 429 || code === "RATE_LIMITED") {
    return msg || "中转站限制 20 秒内只能提交一次生图（聊天配图和纯生图共用），请稍后再试";
  }
  if (status === 504) return "中转站超时，请稍后重试";
  return msg || code || `中转站 ${status}`;
}

function absUrl(base: string, url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  const root = normalizeNaiBase(base);
  return root + (url.startsWith("/") ? url : `/${url}`);
}

function toB64(png: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < png.length; i += chunk) binary += String.fromCharCode(...png.subarray(i, i + chunk));
  return btoa(binary);
}

function extractPng(u8: Uint8Array) {
  if (u8[0] === 0x89 && u8[1] === 0x50) return u8;
  try {
    const files = unzipSync(u8);
    const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".png"));
    return name ? files[name] : (Object.values(files)[0] ?? null);
  } catch {
    return null;
  }
}

function imageField(image?: string) {
  if (!image || image.length < 80) return "";
  return image.includes("base64,") ? image.split("base64,").pop() || "" : image;
}

function parseJob(text: string): JobJson | null {
  if (!text || isChallenge(text)) return null;
  try {
    const j = JSON.parse(text) as JobJson;
    if (j?.data && typeof j.data === "object" && !j.job_id && !j.image && !j.image_url) return { ...j, ...j.data };
    return j;
  } catch {
    return null;
  }
}

async function pull(url: string, init: RequestInit, signal?: AbortSignal, file = false) {
  const hop = AbortSignal.timeout(NAI_HOP_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, hop]) : hop;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: combined });
  } catch (e) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const name = e instanceof Error || e instanceof DOMException ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      const err = new Error("中转站超时，请稍后重试");
      err.name = "HopTimeout";
      throw err;
    }
    if (file) throw new DirectFileError();
    throw new Error("无法连接中转站");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes, text: new TextDecoder().decode(bytes) };
}

async function pullApi(base: string, path: string, init: RequestInit, signal?: AbortSignal) {
  let root = normalizeNaiBase(base);
  let got = await pull(`${root}${path}`, init, signal);
  const moved = naiMigrationBase(got.res.status, got.text);
  if (moved && moved !== root) {
    root = moved;
    got = await pull(`${root}${path}`, init, signal);
  }
  return { ...got, baseUrl: root };
}

function jobHop(j: JobJson, baseUrl: string, pendingOk = false): DirectHop {
  const inline = imageField(j.image);
  if (inline) return { image: inline, baseUrl };
  if (j.error && !j.job_id && !j.id && !j.image_url && !j.v5_delivery?.file_url) {
    throw new Error(typeof j.error === "string" ? j.error : "生成失败");
  }
  const fileUrl = j.v5_delivery?.file_url || j.image_url;
  const jobId = j.job_id || j.id;
  if (j.status === "failed") throw new Error(j.error || j.message || "生成失败");
  if (fileUrl && (j.status === "completed" || !jobId)) {
    return { fileUrl, statusUrl: j.v5_delivery?.status_url, v5: j.v5_delivery, jobId, baseUrl };
  }
  if (!jobId && !j.v5_delivery?.status_url && !fileUrl) {
    if (pendingOk) return { pending: true, statusUrl: j.v5_delivery?.status_url, baseUrl };
    throw new Error(j.message || "中转站没有返回任务");
  }
  return { jobId, statusUrl: j.v5_delivery?.status_url, fileUrl, v5: j.v5_delivery, pending: !fileUrl, baseUrl };
}

export async function directSubmit(base: string, apiKey: string, payload: unknown, signal?: AbortSignal): Promise<DirectHop> {
  const { res, bytes, text, baseUrl } = await pullApi(
    base,
    "/api/generate_image",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
    signal,
  );
  if (!res.ok) throw new Error(mapError(res.status, text));
  const png = extractPng(bytes);
  if (png && (bytes[0] === 0x89 || bytes[0] === 0x50)) return { image: toB64(png), baseUrl };
  if (isChallenge(text)) throw new Error("站点防护拦了这次生图，再试一次");
  const j = parseJob(text);
  if (!j) throw new Error("中转站返回无法解析");
  return jobHop(j, baseUrl);
}

export async function directPoll(base: string, apiKey: string, jobId?: string, statusUrl?: string, signal?: AbortSignal): Promise<DirectHop> {
  const root = normalizeNaiBase(base);
  const url = statusUrl ? absUrl(root, statusUrl) : `${root}/api/get_result/${jobId}`;
  let got: { res: Response; bytes: Uint8Array; text: string; baseUrl: string };
  if (statusUrl && /^https?:\/\//i.test(statusUrl) && !statusUrl.startsWith(root)) {
    const pulled = await pull(url, { headers: { Authorization: `Bearer ${apiKey}` } }, signal);
    got = { ...pulled, baseUrl: root };
  } else {
    const path = url.startsWith(root) ? url.slice(root.length) : url;
    got = await pullApi(root, path.startsWith("/") ? path : `/${path}`, { headers: { Authorization: `Bearer ${apiKey}` } }, signal);
  }
  if (!got.res.ok) throw new Error(mapError(got.res.status, got.text));
  if (isChallenge(got.text)) throw new Error("站点防护拦了这次生图，再试一次");
  const j = parseJob(got.text);
  if (!j) return { pending: true, baseUrl: got.baseUrl };
  if (j.status === "failed" || (j.error && j.status !== "completed" && !j.image_url && !j.image && !j.v5_delivery?.file_url)) {
    throw new Error(j.error || j.message || "生成失败");
  }
  return jobHop(j, got.baseUrl, true);
}

export async function directFetch(base: string, apiKey: string, fileUrl: string, v5?: DirectV5, signal?: AbortSignal): Promise<DirectHop> {
  const url = absUrl(normalizeNaiBase(base), fileUrl);
  const { res, bytes, text } = await pull(url, { headers: { Authorization: `Bearer ${apiKey}` } }, signal, true);
  if (!res.ok || isChallenge(text)) throw new DirectFileError();
  const png = extractPng(bytes);
  if (!png) throw new DirectFileError();
  if (v5?.confirmation_required && v5.confirm_url) {
    try {
      await pull(
        absUrl(normalizeNaiBase(base), v5.confirm_url),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sha256: v5.sha256, size_bytes: v5.size_bytes }),
        },
        signal,
        true,
      );
    } catch {
      /* confirm is optional */
    }
  }
  return { image: toB64(png) };
}
