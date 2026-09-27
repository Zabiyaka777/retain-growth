import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { deleteWalletCard, readOrgMonoToken } from "./_shared/monobank";
import { logLeadActivity } from "./_shared/activity-log";

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
 * Manager-side subscription cancellation (ТЗ item 5: "Скасування — з боку
 * менеджера чи ліда, зупиняє майбутні списання"). A lead-side cancellation
 * would need its own channel-facing flow (a chat command, a self-serve
 * link) — out of scope here; this is the "Скасувати підписку" button in
 * LeadProfile.tsx, the only cancel surface that exists today.
 *
 * Stops future charges immediately (claim_due_subscriptions only ever
 * claims status='active' rows) and best-effort deletes the tokenized card
 * from Monobank's side — failure to do that doesn't block cancellation, the
 * status flip is what actually matters.
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

  let subscriptionId: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!subscriptionId) return jsonResponse(400, { error: "subscriptionId обов'язковий" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }
  const orgId = profile.org_id as string;

  const { data: subscription, error: subError } = await supabase
    .from("subscriptions")
    .select("id, org_id, lead_id, card_token_secret_id, status")
    .eq("id", subscriptionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (subError || !subscription) return jsonResponse(404, { error: "Підписку не знайдено" });
  if (subscription.status === "canceled") return jsonResponse(200, { ok: true }); // already done, not an error

  const { error: updateError } = await supabase.from("subscriptions").update({ status: "canceled", canceled_at: new Date().toISOString() }).eq("id", subscriptionId);
  if (updateError) {
    console.error("save-subscription: cancel update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося скасувати підписку" });
  }

  if (subscription.card_token_secret_id) {
    const { data: cardToken } = await supabase.rpc("vault_read_secret", { secret_id: subscription.card_token_secret_id });
    const creds = cardToken ? await readOrgMonoToken(supabase, orgId) : null;
    if (cardToken && creds) {
      try {
        await deleteWalletCard(creds.token, String(cardToken));
      } catch (err) {
        // Not fatal — the subscription is already canceled and won't be
        // charged again regardless of whether Monobank's own copy of the
        // card token gets cleaned up.
        console.error("save-subscription: deleteWalletCard failed", err);
      }
    }
  }

  if (subscription.lead_id) {
    await logLeadActivity(supabase, {
      orgId,
      leadId: subscription.lead_id as string,
      actionType: "subscription_canceled",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { subscription_id: subscriptionId },
    });
  }

  return jsonResponse(200, { ok: true });
};
