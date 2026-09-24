import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { GRAPH_API_VERSION, loadWhatsAppCredential, type GraphErrorBody } from "./_shared/whatsapp";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const UNIQUE_VIOLATION = "23505";
const VALID_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"];

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

interface TemplateCreateResponse extends GraphErrorBody {
  id?: string;
  status?: string;
}

/**
 * Submits a WhatsApp message template to Meta for review and mirrors it into
 * message_templates so its moderation status is visible in the app. Also
 * handles refresh (re-read status from Meta) and delete.
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

  let action: string;
  let name: string | undefined;
  let language: string;
  let category: string;
  let body: string | undefined;
  let templateId: string | undefined;
  try {
    const parsed = JSON.parse(event.body || "{}");
    action = typeof parsed.action === "string" ? parsed.action : "create";
    name = typeof parsed.name === "string" ? parsed.name.trim() : undefined;
    language = typeof parsed.language === "string" && parsed.language.trim() ? parsed.language.trim() : "uk";
    category = typeof parsed.category === "string" && VALID_CATEGORIES.includes(parsed.category) ? parsed.category : "MARKETING";
    body = typeof parsed.body === "string" ? parsed.body.trim() : undefined;
    templateId = typeof parsed.templateId === "string" ? parsed.templateId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request body (see CLAUDE.md: org_id scoping).
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

  if (action === "delete") {
    if (!templateId) return jsonResponse(400, { error: "templateId обов'язковий" });
    const { data: deleted, error } = await supabase
      .from("message_templates")
      .delete()
      .eq("id", templateId)
      .eq("org_id", orgId)
      .select("id");
    if (error) {
      console.error("save-message-template: delete failed", error);
      return jsonResponse(500, { error: "Не вдалося видалити шаблон" });
    }
    if (!deleted || deleted.length === 0) return jsonResponse(404, { error: "Шаблон не знайдено" });
    return jsonResponse(200, { ok: true });
  }

  const credential = await loadWhatsAppCredential(supabase, orgId);
  if (!credential) {
    return jsonResponse(404, { error: "WhatsApp не підключено" });
  }
  if (!credential.wabaId) {
    // Templates live on the WhatsApp Business Account, not the phone number —
    // without its id there is nothing to submit to.
    return jsonResponse(400, { error: "Не визначено WABA ID — перепідключіть WhatsApp токеном з доступом до бізнес-акаунта" });
  }

  if (action === "refresh") {
    // Statuses change on Meta's side (a PENDING template becomes APPROVED or
    // REJECTED hours later) with no callback into the app, so the list is
    // re-read on demand rather than trusted from the moment of submission.
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${credential.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=200`,
      { headers: { authorization: `Bearer ${credential.accessToken}` } },
    );
    const data = (await res.json().catch(() => null)) as
      | (GraphErrorBody & { data?: { id: string; name: string; language: string; status: string; category?: string; rejected_reason?: string }[] })
      | null;

    if (!res.ok || !data?.data) {
      console.error("save-message-template: list failed", res.status, data);
      return jsonResponse(502, { error: data?.error?.message ?? "Не вдалося отримати статуси з Meta" });
    }

    for (const remote of data.data) {
      const { error } = await supabase
        .from("message_templates")
        .update({
          status: remote.status,
          rejection_reason: remote.rejected_reason && remote.rejected_reason !== "NONE" ? remote.rejected_reason : null,
          meta_template_id: remote.id,
          updated_at: new Date().toISOString(),
        })
        .eq("org_id", orgId)
        .eq("name", remote.name)
        .eq("language", remote.language);
      if (error) console.error("save-message-template: status update failed", remote.name, error);
    }

    return jsonResponse(200, { ok: true, synced: data.data.length });
  }

  // ---- create ----
  if (!name || !body) {
    return jsonResponse(400, { error: "name і body обов'язкові" });
  }
  // Meta's own constraint on template names; rejected here so the error is
  // readable instead of arriving as a Graph validation blob.
  if (!/^[a-z0-9_]+$/.test(name)) {
    return jsonResponse(400, { error: "Назва може містити лише малі латинські літери, цифри та _" });
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${credential.wabaId}/message_templates`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential.accessToken}` },
    body: JSON.stringify({
      name,
      language,
      category,
      // Body-only for now: header/footer/buttons are what turn this into a
      // full template builder, which this first version deliberately isn't.
      components: [{ type: "BODY", text: body }],
    }),
  });
  const data = (await res.json().catch(() => null)) as TemplateCreateResponse | null;

  if (!res.ok || !data?.id) {
    console.error("save-message-template: create failed", res.status, data);
    return jsonResponse(502, { error: data?.error?.message ?? "Meta відхилила створення шаблону" });
  }

  const { data: row, error: insertError } = await supabase
    .from("message_templates")
    .insert({
      org_id: orgId,
      name,
      language,
      category,
      body,
      status: data.status ?? "PENDING",
      meta_template_id: data.id,
    })
    .select("id, name, language, category, body, status, meta_template_id, rejection_reason, created_at")
    .single();

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      return jsonResponse(409, { error: "Шаблон з такою назвою та мовою вже існує" });
    }
    console.error("save-message-template: insert failed", insertError);
    // Meta already has it — report the gap rather than a clean success.
    return jsonResponse(500, { error: "Шаблон подано в Meta, але не збережено локально" });
  }

  return jsonResponse(200, { ok: true, template: row });
};
