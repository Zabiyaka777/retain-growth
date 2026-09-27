import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { logAdminAction, requirePlatformAdmin } from "./_shared/platform-admin";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Platform-wide NON-secret values (platform_config — readable by every signed-in
// user). Secrets go through save-platform-setting.ts / Vault instead. Each key
// has its own normalizer; an empty value removes the key.
const KNOWN_KEYS: Record<string, (v: string) => string | null> = {
  // Sidebar "Підтримка" link: a Telegram username, stored bare (no @ / t.me/).
  support_telegram: (v) => {
    const u = v.replace(/^@/, "").replace(/^https?:\/\/t\.me\//i, "").replace(/\/+$/, "");
    return /^[A-Za-z0-9_]{5,32}$/.test(u) ? u : null;
  },
};

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let key = "";
  let value = "";
  try {
    const b = JSON.parse(event.body || "{}");
    key = typeof b.key === "string" ? b.key.trim() : "";
    value = typeof b.value === "string" ? b.value.trim() : "";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  const normalize = KNOWN_KEYS[key];
  if (!normalize) return jsonResponse(400, { error: "Невідомий ключ налаштування" });
  const normalized = value ? normalize(value) : "";
  if (normalized === null) return jsonResponse(400, { error: "Невалідне значення — для Telegram вкажіть нік, напр. @support_bot" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });

  const { error } = normalized
    ? await supabase.from("platform_config").upsert({ key, value: normalized, updated_at: new Date().toISOString() })
    : await supabase.from("platform_config").delete().eq("key", key);
  if (error) {
    console.error("save-platform-config: write failed", error);
    return jsonResponse(500, { error: "Не вдалося зберегти" });
  }
  await logAdminAction(supabase, admin, "platform_config_saved", { key, value: normalized || null });
  return jsonResponse(200, { ok: true, value: normalized || null });
};
