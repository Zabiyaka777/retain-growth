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

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Registers or removes one browser's Web Push subscription — the only writer
 * of push_subscriptions (client-side RLS only allows reading your own org's
 * rows, same as every other credential-shaped table in this app).
 *
 * endpoint is the subscription's own global identity (see the migration
 * comment): subscribing upserts on it, so re-subscribing the same
 * browser/device — including after switching org — just moves the row
 * forward instead of erroring or duplicating.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let action: "subscribe" | "unsubscribe" | undefined;
  let endpoint: string | undefined;
  let p256dh: string | undefined;
  let authKey: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    action = body.action === "subscribe" || body.action === "unsubscribe" ? body.action : undefined;
    endpoint = typeof body.endpoint === "string" ? body.endpoint : undefined;
    p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : undefined;
    authKey = typeof body.keys?.auth === "string" ? body.keys.auth : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!action || !endpoint) {
    return jsonResponse(400, { error: "action і endpoint обов'язкові" });
  }
  if (action === "subscribe" && (!p256dh || !authKey)) {
    return jsonResponse(400, { error: "keys.p256dh і keys.auth обов'язкові для subscribe" });
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

  if (action === "unsubscribe") {
    const { error: deleteError } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    if (deleteError) {
      console.error("save-push-subscription: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити підписку" });
    }
    return jsonResponse(200, { ok: true });
  }

  const { error: upsertError } = await supabase.from("push_subscriptions").upsert(
    {
      org_id: orgId,
      user_id: userData.user.id,
      endpoint,
      p256dh,
      auth: authKey,
    },
    { onConflict: "endpoint" },
  );

  if (upsertError) {
    console.error("save-push-subscription: upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося зберегти підписку" });
  }

  return jsonResponse(200, { ok: true });
};
