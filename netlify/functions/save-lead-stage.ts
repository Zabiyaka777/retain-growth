import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./_shared/activity-log";
import { maybeSendStageConversion } from "./_shared/stage-conversion";

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

  let leadId: string | undefined;
  let stageId: string | undefined;
  let value: number | null = null;
  try {
    const body = JSON.parse(event.body || "{}");
    leadId = typeof body.leadId === "string" ? body.leadId : undefined;
    stageId = typeof body.stageId === "string" ? body.stageId : undefined;
    if (body.value !== null && body.value !== undefined && body.value !== "") {
      const parsed = Number(body.value);
      if (!Number.isFinite(parsed)) {
        return jsonResponse(400, { error: "Сума має бути числом" });
      }
      value = parsed;
    }
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!leadId || !stageId) {
    return jsonResponse(400, { error: "leadId і stageId обов'язкові" });
  }

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

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, current_stage_id")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (leadError || !lead) {
    return jsonResponse(404, { error: "Лід не знайдено" });
  }

  // A stage is usable by this org when it's either a built-in (org_id NULL)
  // or one of the org's own — the same visibility rule the RLS select policy
  // applies, re-checked here because stageId arrives from the client.
  const { data: stage, error: stageError } = await supabase
    .from("funnel_stages")
    .select("id, org_id, name")
    .eq("id", stageId)
    .maybeSingle();
  if (stageError || !stage || (stage.org_id !== null && stage.org_id !== orgId)) {
    return jsonResponse(404, { error: "Етап не знайдено" });
  }

  // Append-only: every save is a new history row, so moving back and forth
  // between stages keeps the full trail instead of overwriting it.
  const { data: historyRow, error: historyError } = await supabase
    .from("lead_stage_history")
    .insert({ org_id: orgId, lead_id: leadId, stage_id: stageId, value })
    .select("id, stage_id, value, entered_at")
    .single();

  if (historyError || !historyRow) {
    console.error("save-lead-stage: history insert failed", historyError);
    return jsonResponse(500, { error: "Не вдалося зберегти етап" });
  }

  const { error: updateError } = await supabase
    .from("leads")
    .update({ current_stage_id: stageId })
    .eq("id", leadId)
    .eq("org_id", orgId);

  if (updateError) {
    console.error("save-lead-stage: current_stage_id update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося оновити поточний етап ліда" });
  }

  // Named, not id'd: the log is read by people, and a stage renamed later
  // shouldn't retroactively rewrite what this entry says happened.
  const { data: fromStage } = lead.current_stage_id
    ? await supabase.from("funnel_stages").select("name").eq("id", lead.current_stage_id).maybeSingle()
    : { data: null };

  await logLeadActivity(supabase, {
    orgId,
    leadId,
    actionType: "stage_changed",
    actorType: "manager",
    actorUserId: userData.user.id,
    actorEmail: userData.user.email,
    details: { from_stage: (fromStage?.name as string | undefined) ?? null, to_stage: stage.name, value },
  });

  // Awaited so the dispatch finishes before the function returns, but never
  // fatal: the stage is already saved, and the manager's UI shouldn't report
  // an error because an ad platform was unreachable.
  await maybeSendStageConversion(supabase, {
    historyId: historyRow.id as string,
    orgId,
    leadId,
    stageId,
    value,
    enteredAt: historyRow.entered_at as string,
  });

  return jsonResponse(200, { ok: true, entry: historyRow });
};
