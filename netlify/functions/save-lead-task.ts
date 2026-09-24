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

type Action = "create" | "update" | "delete";
const VALID_ACTIONS: Action[] = ["create", "update", "delete"];

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isValidDeadline(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
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

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const action = typeof body.action === "string" ? (body.action as Action) : undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return jsonResponse(400, { error: "Невідома дія" });
  }

  const leadId = typeof body.leadId === "string" ? body.leadId : undefined;
  const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
  const title = typeof body.title === "string" ? body.title.trim() : undefined;
  const completed = typeof body.completed === "boolean" ? body.completed : undefined;
  // Present-but-null clears the deadline; absent means "leave it alone" on
  // update, so this has to distinguish "key missing" from "key is null".
  const deadlineProvided = Object.prototype.hasOwnProperty.call(body, "deadline");
  const deadlineRaw = body.deadline;

  if (deadlineProvided && deadlineRaw !== null && !isValidDeadline(deadlineRaw)) {
    return jsonResponse(400, { error: "Недійсний дедлайн" });
  }

  if (action === "create" && (!leadId || !title)) {
    return jsonResponse(400, { error: "leadId і title обов'язкові" });
  }
  if ((action === "update" || action === "delete") && !taskId) {
    return jsonResponse(400, { error: "taskId обов'язковий" });
  }
  if (action === "update" && title === "") {
    return jsonResponse(400, { error: "Назва задачі не може бути порожньою" });
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

  if (action === "create") {
    // Confirms the lead is actually this org's before attaching a task to
    // it — the update/delete branches get this for free from their own
    // .eq("org_id", orgId) filter, but an insert has no existing row to
    // filter, so it's the one place that needs an explicit ownership check.
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id")
      .eq("id", leadId as string)
      .eq("org_id", orgId)
      .maybeSingle();

    if (leadError || !lead) {
      return jsonResponse(404, { error: "Лід не знайдено" });
    }

    const { data: task, error: insertError } = await supabase
      .from("lead_tasks")
      .insert({
        org_id: orgId,
        lead_id: leadId,
        title,
        deadline: deadlineProvided ? deadlineRaw : null,
      })
      .select("id, lead_id, title, deadline, completed, created_at")
      .single();

    if (insertError) {
      console.error("save-lead-task: insert failed", insertError);
      return jsonResponse(500, { error: "Не вдалося створити задачу" });
    }

    await logLeadActivity(supabase, {
      orgId,
      leadId: leadId as string,
      actionType: "task_created",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { title: task.title, deadline: task.deadline },
    });

    return jsonResponse(200, { ok: true, task });
  }

  if (action === "update") {
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (completed !== undefined) patch.completed = completed;
    if (deadlineProvided) patch.deadline = deadlineRaw;

    if (Object.keys(patch).length === 0) {
      return jsonResponse(400, { error: "Немає полів для оновлення" });
    }

    const { data: task, error: updateError } = await supabase
      .from("lead_tasks")
      .update(patch)
      .eq("id", taskId as string)
      .eq("org_id", orgId)
      .select("id, lead_id, title, deadline, completed, created_at")
      .maybeSingle();

    if (updateError) {
      console.error("save-lead-task: update failed", updateError);
      return jsonResponse(500, { error: "Не вдалося оновити задачу" });
    }
    if (!task) {
      return jsonResponse(404, { error: "Задачу не знайдено" });
    }

    // Only a completion is worth a feed entry — a retitle or a moved deadline
    // is bookkeeping, and logging every keystroke-level edit would bury the
    // events someone actually reads the timeline for.
    if (completed === true) {
      await logLeadActivity(supabase, {
        orgId,
        leadId: task.lead_id as string,
        actionType: "task_completed",
        actorType: "manager",
        actorUserId: userData.user.id,
        actorEmail: userData.user.email,
        details: { title: task.title, deadline: task.deadline },
      });
    }

    return jsonResponse(200, { ok: true, task });
  }

  // action === "delete" — read first so the log can name what was removed.
  const { data: doomed } = await supabase
    .from("lead_tasks")
    .select("lead_id, title, deadline")
    .eq("id", taskId as string)
    .eq("org_id", orgId)
    .maybeSingle();

  const { error: deleteError } = await supabase.from("lead_tasks").delete().eq("id", taskId as string).eq("org_id", orgId);

  if (deleteError) {
    console.error("save-lead-task: delete failed", deleteError);
    return jsonResponse(500, { error: "Не вдалося видалити задачу" });
  }

  if (doomed) {
    await logLeadActivity(supabase, {
      orgId,
      leadId: doomed.lead_id as string,
      actionType: "task_deleted",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { title: doomed.title, deadline: doomed.deadline },
    });
  }

  return jsonResponse(200, { ok: true });
};
