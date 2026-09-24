import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY!;
const vapidSubject = process.env.VAPID_SUBJECT!;
// Not the secret itself — a pointer into Vault, same indirection this
// codebase already uses for per-org channel credentials (e.g.
// bot_token_secret_id), just platform-wide instead of per-org since there's
// only one VAPID key pair for the whole app.
const vapidPrivateKeySecretId = process.env.VAPID_PRIVATE_KEY_SECRET_ID!;

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Called only by telegram-webhook.ts / whatsapp-webhook.ts, never by a
// browser — same guard as ai-respond.ts and transcribe-voice.ts.
function isInternalCall(event: Parameters<Handler>[0]): boolean {
  const provided = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  return !!provided && provided === serviceRoleKey;
}

/**
 * Fans a new inbound message out to every browser subscribed to push for the
 * lead's org. No per-manager targeting yet (see the caller for why) — every
 * subscription on the org gets the same notification.
 *
 * A subscription that the push service rejects as gone (410, or 404 for a
 * couple of providers that use it the same way) is deleted on the spot:
 * there's no recovery path for a stale endpoint, so leaving the row around
 * only costs a failed send next time too.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }
  if (!isInternalCall(event)) {
    return jsonResponse(403, { error: "Forbidden" });
  }

  let orgId: string | undefined;
  let threadId: string | undefined;
  let title: string | undefined;
  let body: string | undefined;
  try {
    const parsed = JSON.parse(event.body || "{}");
    orgId = typeof parsed.orgId === "string" ? parsed.orgId : undefined;
    threadId = typeof parsed.threadId === "string" ? parsed.threadId : undefined;
    title = typeof parsed.title === "string" ? parsed.title : undefined;
    body = typeof parsed.body === "string" ? parsed.body : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!orgId || !threadId) {
    return jsonResponse(400, { error: "orgId і threadId обов'язкові" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: subscriptions, error: subsError } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("org_id", orgId);

  if (subsError) {
    console.error("send-push-notification: push_subscriptions lookup failed", subsError);
    return jsonResponse(500, { error: "Не вдалося отримати підписки" });
  }
  if (!subscriptions || subscriptions.length === 0) {
    return jsonResponse(200, { ok: true, sent: 0 });
  }

  const { data: privateKey, error: keyError } = await supabase.rpc("vault_read_secret", {
    secret_id: vapidPrivateKeySecretId,
  });
  if (keyError || !privateKey) {
    console.error("send-push-notification: failed to decrypt VAPID private key", keyError);
    return jsonResponse(500, { error: "Не вдалося прочитати VAPID-ключ" });
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, privateKey as string);

  const payload = JSON.stringify({
    title: title || "Нове повідомлення",
    body: body || "",
    threadId,
  });

  const staleIds: string[] = [];
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 410 || statusCode === 404) {
          staleIds.push(sub.id);
        } else {
          console.error("send-push-notification: send failed", sub.id, err);
        }
      }
    }),
  );

  if (staleIds.length > 0) {
    const { error: deleteError } = await supabase.from("push_subscriptions").delete().in("id", staleIds);
    if (deleteError) console.error("send-push-notification: stale subscription cleanup failed", deleteError);
  }

  return jsonResponse(200, { ok: true, sent, removed: staleIds.length });
};
