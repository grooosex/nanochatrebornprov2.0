import { DEFAULT_NAI_BASE } from "./constants";

const ENDINGS = [
  "/ai/generate-image-stream",
  "/ai/generate-image",
  "/generate_image",
  "/user/subscription",
  "/user/data",
];

/** 中转站根地址。`https://主机` 和 `https://主机/api` 都变成同一根，后面再接 `/api/...`。 */
export function normalizeNaiBase(input?: string): string {
  let raw = (input || "").trim();
  if (!raw) return DEFAULT_NAI_BASE;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  raw = raw.replace(/\/+$/, "");
  raw = raw.replace(/\/get_result(?:\/[^/]+)?$/i, "");
  const lower = raw.toLowerCase();
  for (const end of ENDINGS) {
    if (lower.endsWith(end)) {
      raw = raw.slice(0, -end.length);
      break;
    }
  }
  raw = raw.replace(/\/+$/, "").replace(/(?:\/api)+$/i, "").replace(/\/+$/, "");
  return raw || DEFAULT_NAI_BASE;
}

/** 旧站用 JSON 告知新地址时才跟着走。普通网页里的链接不跟。 */
export function naiMigrationBase(status: number, body: string): string | null {
  if (!body || status === 200) return null;
  let code = "";
  let msg = "";
  let given = "";
  try {
    const j = JSON.parse(body) as { code?: string; error?: string; message?: string; message_en?: string; api_base_url?: string };
    code = String(j.code || j.error || "");
    msg = String(j.message || j.message_en || "");
    given = String(j.api_base_url || "");
  } catch {
    return null;
  }
  const moved = code === "API_DOMAIN_CHANGED" || msg.includes("域名已迁移") || /has moved/i.test(msg);
  if (!moved) return null;
  const fromMsg = msg.match(/https?:\/\/[^\s"'<>]+/i)?.[0]?.replace(/[),.;]+$/, "") || "";
  const next = normalizeNaiBase(given || fromMsg);
  if (!/^https?:\/\//i.test(next)) return null;
  return next;
}
