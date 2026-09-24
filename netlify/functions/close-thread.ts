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

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let threadId: string | undefined;
  let action: "close" | "open" = "close";
  try {
    const body = JSON.parse(event.body || "{}");
    threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    // Defaults to "close" so every existing caller (which never sends this
    // field) keeps its exact prior behavior.
    if (body.action === "open") action = "open";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!threadId) {
    return jsonResponse(400, { error: "threadId обов'язковий" });
  }

  const nextStatus = action === "open" ? "open" : "closed";

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

  // The log is per lead, and a thread names its own — read before the update
  // so a failed lookup can't be mistaken for a failed close.
  const { data: threadRow } = await supabase
    .from("threads")
    .select("lead_id")
    .eq("id", threadId)
    .eq("org_id", profile.org_id as string)
    .maybeSingle();

  // Same 'closed' status the close_chat funnel action already sets
  // (funnel-graph.ts) — a manager-initiated close (or reopen) is just
  // another writer of the same field, not a new state.
  const { error: updateError } = await supabase
    .from("threads")
    .update({ status: nextStatus })
    .eq("id", threadId)
    .eq("org_id", profile.org_id as string);

  if (updateError) {
    console.error("close-thread: update failed", updateError);
    return jsonResponse(500, { error: action === "open" ? "Не вдалося відкрити тред" : "Не вдалося закрити тред" });
  }

  if (threadRow?.lead_id) {
    await logLeadActivity(supabase, {
      orgId: profile.org_id as string,
      leadId: threadRow.lead_id as string,
      actionType: "status_changed",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { new_status: nextStatus },
    });
  }

  return jsonResponse(200, { ok: true });
};
