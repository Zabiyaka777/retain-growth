import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Cheapest possible "is this key real" probe — spends no tokens. Note
// OpenRouter's /models is public, so it can't validate a key; /key is the
// authenticated endpoint that can.
const PROBE_URL = "https://openrouter.ai/api/v1/key";

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let apiKey: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!apiKey) {
    return jsonResponse(400, { error: "apiKey обов'язковий" });
  }

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request (see CLAUDE.md: org_id scoping).
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }

  const orgId = profile.org_id as string;

  // The equivalent of Telegram's getMe: an authenticated call that spends no
  // tokens, so a wrong key is rejected before we ever store it.
  try {
    const probeRes = await fetch(PROBE_URL, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!probeRes.ok) {
      const detail = (await probeRes.json().catch(() => null)) as { error?: { message?: string } } | null;
      console.error("connect-ai: key probe rejected", probeRes.status, detail);
      return jsonResponse(400, {
        error:
          probeRes.status === 401 || probeRes.status === 403
            ? "Невалідний OpenRouter API ключ"
            : (detail?.error?.message ?? "OpenRouter API відхилив ключ"),
      });
    }
  } catch (err) {
    console.error("connect-ai: key probe failed", err);
    return jsonResponse(502, { error: "Не вдалося зв'язатися з OpenRouter API" });
  }

  const { data: existing } = await supabase.from("ai_credentials").select("id, api_key_secret_id").eq("org_id", orgId).maybeSingle();

  // vault.secrets.name is uniquely indexed and is only a human-readable label
  // (lookups always go through ai_credentials.api_key_secret_id) — the
  // timestamp suffix keeps reconnects from colliding with the still-live secret.
  const { data: apiKeySecretId, error: secretError } = await supabase.rpc("vault_create_secret", {
    secret: apiKey,
    name: `openrouter_api_key_${orgId}_${Date.now()}`,
    description: "OpenRouter API key",
  });

  if (secretError || !apiKeySecretId) {
    console.error("connect-ai: vault_create_secret failed", secretError);
    return jsonResponse(500, { error: "Не вдалося зберегти ключ" });
  }

  const { error: upsertError } = await supabase
    .from("ai_credentials")
    .upsert({ org_id: orgId, api_key_secret_id: apiKeySecretId }, { onConflict: "org_id" });

  if (upsertError) {
    console.error("connect-ai: ai_credentials upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося зберегти інтеграцію" });
  }

  // Only now has the row stopped pointing at the old secret, so deleting it no
  // longer trips the FK's NO ACTION restriction (same lesson as connect-telegram).
  if (existing?.api_key_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.api_key_secret_id });
    if (error) console.error("connect-ai: vault_delete_secret (old key) failed", error);
  }

  return jsonResponse(200, { ok: true });
};
