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

// Attaches/detaches one of the org's catalog tags to a single lead. The
// catalog itself (creating/deleting the tag) stays in save-tag.ts — this only
// touches the lead_tags join.
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
  let tagId: string | undefined;
  let action: "add" | "remove" | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    leadId = typeof body.leadId === "string" ? body.leadId : undefined;
    tagId = typeof body.tagId === "string" ? body.tagId : undefined;
    action = body.action === "add" || body.action === "remove" ? body.action : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!leadId || !tagId || !action) {
    return jsonResponse(400, { error: "leadId, tagId і action обов'язкові" });
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

  // Read before the write so the log can name the tag rather than its id —
  // and so a later rename doesn't rewrite history.
  const { data: tagRow } = await supabase.from("tags").select("name").eq("id", tagId).eq("org_id", orgId).maybeSingle();
  const tagName = (tagRow?.name as string | undefined) ?? null;

  if (action === "remove") {
    const { error: deleteError } = await supabase
      .from("lead_tags")
      .delete()
      .eq("lead_id", leadId)
      .eq("tag_id", tagId)
      .eq("org_id", orgId);
    if (deleteError) {
      console.error("save-lead-tag: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося зняти тег" });
    }

    await logLeadActivity(supabase, {
      orgId,
      leadId,
      actionType: "tag_removed",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { tag_name: tagName },
    });

    return jsonResponse(200, { ok: true });
  }

  // Both sides are checked against the org before the join row is written —
  // an insert has no existing row for an .eq("org_id") filter to guard.
  const [leadRes, tagRes] = await Promise.all([
    supabase.from("leads").select("id").eq("id", leadId).eq("org_id", orgId).maybeSingle(),
    supabase.from("tags").select("id").eq("id", tagId).eq("org_id", orgId).maybeSingle(),
  ]);
  if (leadRes.error || !leadRes.data) {
    return jsonResponse(404, { error: "Лід не знайдено" });
  }
  if (tagRes.error || !tagRes.data) {
    return jsonResponse(404, { error: "Тег не знайдено" });
  }

  // Same upsert shape funnel-graph.ts's set_tag action uses, so a tag added
  // by hand and one added by a funnel land identically.
  const { error: upsertError } = await supabase
    .from("lead_tags")
    .upsert({ lead_id: leadId, org_id: orgId, tag_id: tagId }, { onConflict: "lead_id,tag_id" });

  if (upsertError) {
    console.error("save-lead-tag: upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося додати тег" });
  }

  await logLeadActivity(supabase, {
    orgId,
    leadId,
    actionType: "tag_added",
    actorType: "manager",
    actorUserId: userData.user.id,
    actorEmail: userData.user.email,
    details: { tag_name: tagName },
  });

  return jsonResponse(200, { ok: true });
};
