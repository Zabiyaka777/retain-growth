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

// Sets one variable's value on a single lead. The variable_defs catalog
// itself stays in save-variable-def.ts — this only writes the lead_variables
// row, mirroring funnel-graph.ts's set_variable action.
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
  let variableDefId: string | undefined;
  let value: string | null = null;
  let remove = false;
  try {
    const body = JSON.parse(event.body || "{}");
    leadId = typeof body.leadId === "string" ? body.leadId : undefined;
    variableDefId = typeof body.variableDefId === "string" ? body.variableDefId : undefined;
    remove = body.remove === true;
    if (typeof body.value === "string") value = body.value.trim() === "" ? null : body.value;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!leadId || !variableDefId) {
    return jsonResponse(400, { error: "leadId і variableDefId обов'язкові" });
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

  // Both the label and the previous value are read before the write, so the
  // log can say what actually changed.
  const [defRow, prevRow] = await Promise.all([
    supabase.from("variable_defs").select("label").eq("id", variableDefId).eq("org_id", orgId).maybeSingle(),
    supabase
      .from("lead_variables")
      .select("value")
      .eq("lead_id", leadId)
      .eq("variable_def_id", variableDefId)
      .eq("org_id", orgId)
      .maybeSingle(),
  ]);
  const varLabel = (defRow.data?.label as string | undefined) ?? null;
  const oldValue = (prevRow.data?.value as string | null | undefined) ?? null;

  if (remove) {
    const { error: deleteError } = await supabase
      .from("lead_variables")
      .delete()
      .eq("lead_id", leadId)
      .eq("variable_def_id", variableDefId)
      .eq("org_id", orgId);
    if (deleteError) {
      console.error("save-lead-variable: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити значення змінної" });
    }

    await logLeadActivity(supabase, {
      orgId,
      leadId,
      actionType: "variable_changed",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { key: varLabel, old_value: oldValue, new_value: null },
    });

    return jsonResponse(200, { ok: true });
  }

  // Both sides checked against the org before the row is written — an upsert
  // has no existing row for an .eq("org_id") filter to guard.
  const [leadRes, defRes] = await Promise.all([
    supabase.from("leads").select("id").eq("id", leadId).eq("org_id", orgId).maybeSingle(),
    supabase.from("variable_defs").select("id").eq("id", variableDefId).eq("org_id", orgId).maybeSingle(),
  ]);
  if (leadRes.error || !leadRes.data) {
    return jsonResponse(404, { error: "Лід не знайдено" });
  }
  if (defRes.error || !defRes.data) {
    return jsonResponse(404, { error: "Змінну не знайдено" });
  }

  const { error: upsertError } = await supabase.from("lead_variables").upsert(
    {
      lead_id: leadId,
      org_id: orgId,
      variable_def_id: variableDefId,
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "lead_id,variable_def_id" },
  );

  if (upsertError) {
    console.error("save-lead-variable: upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося зберегти значення змінної" });
  }

  await logLeadActivity(supabase, {
    orgId,
    leadId,
    actionType: "variable_changed",
    actorType: "manager",
    actorUserId: userData.user.id,
    actorEmail: userData.user.email,
    details: { key: varLabel, old_value: oldValue, new_value: value },
  });

  return jsonResponse(200, { ok: true });
};
