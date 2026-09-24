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

type LeadStatus = "active" | "blocked" | "archived";
const VALID_STATUSES: LeadStatus[] = ["active", "blocked", "archived"];

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

  let leadId: string | undefined;
  let status: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    leadId = typeof body.leadId === "string" ? body.leadId : undefined;
    status = typeof body.status === "string" ? body.status : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!leadId || !status) {
    return jsonResponse(400, { error: "leadId і status обов'язкові" });
  }
  if (!VALID_STATUSES.includes(status as LeadStatus)) {
    return jsonResponse(400, { error: "Невідомий статус ліда" });
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

  const { error: updateError } = await supabase
    .from("leads")
    .update({ status })
    .eq("id", leadId)
    .eq("org_id", profile.org_id as string);

  if (updateError) {
    console.error("update-lead-status: update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося оновити статус ліда" });
  }

  await logLeadActivity(supabase, {
    orgId: profile.org_id as string,
    leadId,
    actionType: "status_changed",
    actorType: "manager",
    actorUserId: userData.user.id,
    actorEmail: userData.user.email,
    details: { new_status: status },
  });

  return jsonResponse(200, { ok: true });
};
