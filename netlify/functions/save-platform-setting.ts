import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { logAdminAction, requirePlatformAdmin } from "./_shared/platform-admin";
import { getMerchantDetails, type MonoMerchant } from "./_shared/monobank";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// monobank_platform_token — Plata by Mono for Retain Growth's own billing
// (charging organizations), not any org's own gateway (payment-account.ts).
const KNOWN_KEYS = new Set(["netlify_api_token", "monobank_platform_token"]);

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Platform-level secrets (currently just the Netlify API token used to
// manage custom-domain aliases) — admin-only, org-independent. Same
// create-then-swap Vault pattern as every per-org credential in this app,
// just keyed by platform_settings.key instead of an org_id row.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let key = "";
  let value = "";
  let action = "save";
  try {
    const body = JSON.parse(event.body || "{}");
    key = typeof body.key === "string" ? body.key.trim() : "";
    value = typeof body.value === "string" ? body.value.trim() : "";
    if (body.action === "verify") action = "verify";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!KNOWN_KEYS.has(key)) return jsonResponse(400, { error: "Невідомий ключ налаштування" });
  if (action === "save" && !value) return jsonResponse(400, { error: "Значення обов'язкове" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });

  // «Перевірити»: the stored token against the gateway, nothing written.
  if (action === "verify") {
    if (key !== "monobank_platform_token") return jsonResponse(400, { error: "Перевірка доступна лише для токена monobank" });
    const { data: row } = await supabase.from("platform_settings").select("secret_id").eq("key", key).maybeSingle();
    if (!row) return jsonResponse(404, { error: "Токен ще не збережено" });
    const { data: token } = await supabase.rpc("vault_read_secret", { secret_id: row.secret_id });
    if (!token) return jsonResponse(500, { error: "Не вдалося прочитати токен" });
    try {
      const merchant = await getMerchantDetails(String(token));
      await logAdminAction(supabase, admin, "platform_setting_verified", { key, merchant_id: merchant.merchantId });
      return jsonResponse(200, { ok: true, merchant });
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message });
    }
  }

  // A payment token is checked against monobank before it replaces anything.
  let merchant: MonoMerchant | null = null;
  if (key === "monobank_platform_token") {
    try {
      merchant = await getMerchantDetails(value);
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message });
    }
  }

  const { data: secretId, error: secretError } = await supabase.rpc("vault_create_secret", {
    secret: value,
    name: `platform_setting_${key}_${Date.now()}`,
    description: `Platform setting: ${key}`,
  });
  if (secretError || !secretId) {
    console.error("save-platform-setting: vault_create_secret failed", secretError);
    return jsonResponse(500, { error: "Не вдалося зберегти секрет" });
  }

  const { data: existing } = await supabase.from("platform_settings").select("secret_id").eq("key", key).maybeSingle();

  const { error: upsertError } = await supabase
    .from("platform_settings")
    .upsert({ key, secret_id: secretId, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (upsertError) {
    console.error("save-platform-setting: upsert failed", upsertError);
    await supabase.rpc("vault_delete_secret", { secret_id: secretId });
    return jsonResponse(500, { error: "Не вдалося зберегти налаштування" });
  }

  // Only after the row points at the new secret is the old one released.
  if (existing?.secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.secret_id });
    if (error) console.error("save-platform-setting: vault_delete_secret (old) failed", error);
  }

  await logAdminAction(supabase, admin, "platform_setting_saved", { key, ...(merchant ? { merchant_id: merchant.merchantId } : {}) });

  return jsonResponse(200, { ok: true, merchant });
};
