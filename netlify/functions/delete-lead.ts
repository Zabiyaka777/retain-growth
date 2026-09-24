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
 * Permanent, irreversible deletion of a lead — the "Видалити" button in
 * LeadProfile.tsx, not the reversible block/archive actions.
 *
 * Every table that references leads.id (directly, or transitively through
 * threads.id) already has ON DELETE CASCADE — verified against
 * information_schema before writing this: threads, messages, funnel_states,
 * ai_conversation_log, lead_tags, lead_variables, lead_tasks,
 * lead_activity_log, lead_stage_history, lead_subscription_events, and
 * lead_memory all cascade. A single delete on `leads` therefore removes all
 * of it atomically — no separate sequential deletes needed, and none would
 * be safer than what Postgres already does in one transaction.
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
  try {
    const body = JSON.parse(event.body || "{}");
    leadId = typeof body.leadId === "string" ? body.leadId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!leadId) {
    return jsonResponse(400, { error: "leadId обов'язковий" });
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

  const { data: deleted, error: deleteError } = await supabase
    .from("leads")
    .delete()
    .eq("id", leadId)
    .eq("org_id", orgId)
    .select("id");

  if (deleteError) {
    console.error("delete-lead: delete failed", deleteError);
    return jsonResponse(500, { error: "Не вдалося видалити ліда" });
  }
  if (!deleted || deleted.length === 0) {
    return jsonResponse(404, { error: "Ліда не знайдено" });
  }

  return jsonResponse(200, { ok: true });
};
