import { createFileRoute } from "@tanstack/react-router";
import { unzipSync } from "fflate";
import { DEFAULT_NAI_BASE, NAI_HOP_TIMEOUT_MS } from "@/lib/constants";
import { naiMigrationBase, normalizeNaiBase } from "@/lib/nai-base";

function absUrl(base: string, url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  const root = normalizeNaiBase(base);
  return root + (url.startsWith("/") ? url : `/${url}`);
}

function looksHtml(text: string) {
  const t = text.trimStart().slice(0, 80).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.startsWith("<?xml") || t.includes("<title>internal server error");
}

function isCfChallenge(status: number, text: string) {
  if (status !== 403 && status !== 503) return false;
  const t = text.slice(0, 500).toLowerCase();
  return t.includes("just a moment") || t.includes("cf-browser-verification") || t.includes("challenge-platform") || t.includes("checking your browser");
}

function mapIdlecloudError(status: number, body: string) {
  if (looksHtml(body)) return "中转站返回了异常页面";
  let code = "";
  let msg = "";
  try {
    const j = JSON.parse(body) as { error?: string; message?: string; detail?: string };
    code = String(j.error || "");
    msg = String(j.message || j.detail || "");
  } catch {
    if (body) msg = body.slice(0, 180);
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

function authHeaders(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json, application/zip, image/png, */*",
  };
}

type V5Delivery = {
  status_url?: string;
  file_url?: string;
  confirm_url?: string;
  confirmation_required?: boolean;
  sha256?: string;
  size_bytes?: number;
};

type JobJson = {
  job_id?: string;
  id?: string;
  status?: string;
  image_url?: string;
  image?: string;
  error?: string;
  message?: string;
  data?: JobJson;
  v5_delivery?: V5Delivery;
};

function parseJob(text: string): JobJson | null {
  if (!text || looksHtml(text)) return null;
  try {
    const j = JSON.parse(text) as JobJson;
    if (j?.data && typeof j.data === "object" && !j.job_id && !j.image && !j.image_url) return { ...j, ...j.data };
    return j;
  } catch {
    return null;
  }
}

function toB64(png: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < png.length; i += chunk) {
    binary += String.fromCharCode(...png.subarray(i, i + chunk));
  }
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

export const Route = createFileRoute("/api/nai")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          action?: "test" | "submit" | "poll" | "fetch" | "generate" | "official" | "official-test";
          baseUrl?: string;
          apiKey?: string;
          payload?: unknown;
          jobId?: string;
          statusUrl?: string;
          fileUrl?: string;
          v5?: V5Delivery;
        };
        let base = normalizeNaiBase(body.baseUrl || DEFAULT_NAI_BASE);
        const key = (body.apiKey || "").trim();
        if (!key) return Response.json({ ok: false, error: "请填写 NAI API Key" }, { status: 400 });

        const loadAt = async (url: string, init?: RequestInit) => {
          const pull = async (target: string) => {
            const res = await fetch(target, init);
            const bytes = new Uint8Array(await res.arrayBuffer());
            return { res, bytes, text: new TextDecoder().decode(bytes) };
          };
          let got = await pull(url);
          const moved = naiMigrationBase(got.res.status, got.text);
          if (moved && moved !== base && (url === base || url.startsWith(`${base}/`))) {
            const next = moved + url.slice(base.length);
            base = moved;
            got = await pull(next);
          }
          return got;
        };

        if (body.action === "official-test") {
          try {
            const r = await fetch("https://image.novelai.net/user/subscription", {
              headers: { Authorization: `Bearer ${key}` },
            });
            if (r.status === 401 || r.status === 403) return Response.json({ ok: false, error: "官网密钥无效" });
            if (!r.ok) return Response.json({ ok: false, error: "官网连接失败" });
            return Response.json({ ok: true });
          } catch (e) {
            return Response.json({ ok: false, error: e instanceof Error ? e.message : "无法连接官网" });
          }
        }

        if (body.action === "official") {
          try {
            const r = await fetch("https://image.novelai.net/ai/generate-image", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                Accept: "application/zip, application/json",
              },
              body: JSON.stringify(body.payload ?? {}),
              signal: AbortSignal.timeout(110000),
            });
            const u8 = new Uint8Array(await r.arrayBuffer());
            if (!r.ok) {
              const text = new TextDecoder().decode(u8);
              let msg = "";
              try {
                const j = JSON.parse(text) as { message?: string; error?: string };
                msg = j.message || j.error || "";
              } catch {
                msg = text.slice(0, 180);
              }
              if (r.status === 401 || r.status === 403) return Response.json({ ok: false, error: "官网密钥无效" });
              if (r.status === 402) return Response.json({ ok: false, error: "官网额度不足" });
              return Response.json({ ok: false, error: msg || `官网 ${r.status}` });
            }
            const png = extractPng(u8);
            if (!png) return Response.json({ ok: false, error: "官网没有返回图片" });
            return Response.json({ ok: true, image: toB64(png) });
          } catch (e) {
            const abort = (e instanceof DOMException || e instanceof Error) && (e.name === "AbortError" || e.name === "TimeoutError");
            return Response.json({ ok: false, error: abort ? "官网生图超时" : e instanceof Error ? e.message : "官网生图失败" });
          }
        }

        const reply = (data: Record<string, unknown>) => Response.json({ ...data, baseUrl: base });

        if (body.action === "test") {
          try {
            const url = `${base}/api/user/subscription`;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt) await new Promise((resolve) => setTimeout(resolve, 700));
              const { res, text } = await loadAt(url, {
                headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
              });
              let json: unknown = null;
              if (!looksHtml(text)) {
                try {
                  json = JSON.parse(text);
                } catch {
                  json = null;
                }
              }
              if (json && typeof json === "object") {
                if (res.status === 401 || res.status === 403) return reply({ ok: false, error: mapIdlecloudError(res.status, text) });
                if (!res.ok) return reply({ ok: false, error: mapIdlecloudError(res.status, text) });
                return reply({ ok: true });
              }
              if (!isCfChallenge(res.status, text)) {
                return reply({ ok: false, error: looksHtml(text) ? "中转站返回了异常页面" : mapIdlecloudError(res.status, text) });
              }
            }
            return reply({ ok: false, error: "站点防护拦了这次连接，再点一次" });
          } catch (e) {
            return reply({
              ok: false,
              error: e instanceof Error ? e.message : "无法连接中转站",
            });
          }
        }

        const hop = AbortSignal.timeout(NAI_HOP_TIMEOUT_MS);
        try {
          if (body.action === "fetch") {
            if (!body.fileUrl) return reply({ ok: false, error: "缺少图片地址" });
            const { res, bytes, text } = await loadAt(absUrl(base, body.fileUrl), { headers: authHeaders(key), signal: hop });
            if (!res.ok) return reply({ ok: false, error: mapIdlecloudError(res.status, text) });
            const png = extractPng(bytes);
            if (!png) return reply({ ok: false, error: "中转站没有返回图片" });
            const v5 = body.v5;
            if (v5?.confirmation_required && v5.confirm_url) {
              try {
                await loadAt(absUrl(base, v5.confirm_url), {
                  method: "POST",
                  headers: { ...authHeaders(key), "Content-Type": "application/json" },
                  body: JSON.stringify({ sha256: v5.sha256, size_bytes: v5.size_bytes }),
                });
              } catch {
                /* confirm is optional */
              }
            }
            return reply({ ok: true, image: toB64(png) });
          }

          if (body.action === "poll") {
            if (!body.jobId && !body.statusUrl) return reply({ ok: false, error: "缺少任务编号" });
            const url = body.statusUrl ? absUrl(base, body.statusUrl) : `${base}/api/get_result/${body.jobId}`;
            const { res, text } = await loadAt(url, { headers: authHeaders(key), signal: hop });
            if (!res.ok) return reply({ ok: false, error: mapIdlecloudError(res.status, text) });
            if (looksHtml(text)) return reply({ ok: false, error: "中转站返回了异常页面" });
            const j = parseJob(text);
            if (!j) return reply({ ok: true, pending: true });
            if (j.status === "failed" || (j.error && j.status !== "completed" && !j.image_url && !j.image && !j.v5_delivery?.file_url)) {
              return reply({ ok: false, error: j.error || j.message || "生成失败" });
            }
            const inline = imageField(j.image);
            if (inline) return reply({ ok: true, image: inline });
            const fileUrl = j.v5_delivery?.file_url || j.image_url;
            if (j.status === "completed" || fileUrl) {
              if (!fileUrl) return reply({ ok: true, pending: true, statusUrl: j.v5_delivery?.status_url });
              return reply({
                ok: true,
                fileUrl,
                statusUrl: j.v5_delivery?.status_url,
                v5: j.v5_delivery,
              });
            }
            return reply({ ok: true, pending: true, statusUrl: j.v5_delivery?.status_url });
          }

          const { res, bytes, text } = await loadAt(`${base}/api/generate_image`, {
            method: "POST",
            headers: { ...authHeaders(key), "Content-Type": "application/json" },
            body: JSON.stringify(body.payload ?? {}),
            signal: hop,
          });
          if (!res.ok) return reply({ ok: false, error: mapIdlecloudError(res.status, text) });
          const png = extractPng(bytes);
          if (png && (bytes[0] === 0x89 || bytes[0] === 0x50)) return reply({ ok: true, image: toB64(png) });
          if (looksHtml(text)) return reply({ ok: false, error: "中转站返回了异常页面" });
          const j = parseJob(text);
          if (!j) return reply({ ok: false, error: "中转站返回无法解析" });
          const inline = imageField(j.image);
          if (inline) return reply({ ok: true, image: inline });
          if (j.error && !j.job_id && !j.id) return reply({ ok: false, error: j.error });
          const fileUrl = j.v5_delivery?.file_url || j.image_url;
          const jobId = j.job_id || j.id;
          if (fileUrl && !jobId) return reply({ ok: true, fileUrl, v5: j.v5_delivery });
          if (!jobId && !j.v5_delivery?.status_url) return reply({ ok: false, error: "中转站没有返回任务" });
          return reply({
            ok: true,
            jobId,
            statusUrl: j.v5_delivery?.status_url,
            fileUrl,
            v5: j.v5_delivery,
          });
        } catch (e) {
          const abort = (e instanceof DOMException || e instanceof Error) && (e.name === "AbortError" || e.name === "TimeoutError");
          return reply({
            ok: false,
            error: abort ? "中转站超时，请稍后重试" : e instanceof Error ? e.message : "生图请求失败",
          });
        }
      },
    },
  },
});
