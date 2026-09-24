import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
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
 * Manual counterpart to the graph's own subscribe/unsubscribe action node
 * (see _shared/funnel-graph.ts's logSubscriptionEvent) — a manager flipping
 * the toggle in LeadProfile.tsx must leave exactly the same trail an
 * automatic action node would: leads.subscribed updated, and a
 * lead_subscription_events row so "Підписки за джерелом" counts a manual
 * change the same way it counts an automatic one. No guard against a
 * no-op (already in that state) — the automatic node doesn't have one
 * either, so this stays consistent with it rather than diverging.
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

  let leadId: string | undefined;
  let subscribed: boolean | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    leadId = typeof body.leadId === "string" ? body.leadId : undefined;
    subscribed = typeof body.subscribed === "boolean" ? body.subscribed : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!leadId || typeof subscribed !== "boolean") {
    return jsonResponse(400, { error: "leadId і subscribed обов'язкові" });
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

  const { data: lead, error: updateError } = await supabase
    .from("leads")
    .update({ subscribed })
    .eq("id", leadId)
    .eq("org_id", orgId)
    .select("id, source_link_id")
    .maybeSingle();

  if (updateError) {
    console.error("update-lead-subscription: update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося оновити статус підписки" });
  }
  if (!lead) {
    return jsonResponse(404, { error: "Ліда не знайдено" });
  }

  const { error: eventError } = await supabase.from("lead_subscription_events").insert({
    org_id: orgId,
    lead_id: leadId,
    link_id: (lead.source_link_id as string | null) ?? null,
    event_type: subscribed ? "subscribe" : "unsubscribe",
  });
  if (eventError) console.error("update-lead-subscription: lead_subscription_events insert failed", eventError);

  // An unsubscribe means the lead no longer wants to hear from this org at
  // all — same 'closed' status close-thread.ts sets for a single thread, just
  // applied to every open thread this lead has (there can be more than one
  // channel). Subscribing back doesn't reopen anything; that stays a manual
  // decision.
  if (!subscribed) {
    const { error: closeError } = await supabase
      .from("threads")
      .update({ status: "closed" })
      .eq("lead_id", leadId)
      .eq("org_id", orgId)
      .eq("status", "open");
    if (closeError) console.error("update-lead-subscription: closing threads failed", closeError);
  }

  await logLeadActivity(supabase, {
    orgId,
    leadId,
    actionType: "subscription_changed",
    actorType: "manager",
    actorUserId: userData.user.id,
    actorEmail: userData.user.email,
    details: { subscribed },
  });

  return jsonResponse(200, { ok: true, subscribed });
};
