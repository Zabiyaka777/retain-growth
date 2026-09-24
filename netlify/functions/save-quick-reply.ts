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

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let id: string | undefined;
  let title: string | undefined;
  let text: string | undefined;
  let deleteReply = false;
  try {
    const body = JSON.parse(event.body || "{}");
    id = typeof body.id === "string" ? body.id : undefined;
    title = typeof body.title === "string" ? body.title.trim() : undefined;
    text = typeof body.text === "string" ? body.text.trim() : undefined;
    deleteReply = body.delete === true && typeof body.id === "string";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!deleteReply && (!title || !text)) {
    return jsonResponse(400, { error: "Назва і текст обов'язкові" });
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

  if (deleteReply) {
    const { error: deleteError } = await supabase.from("quick_replies").delete().eq("id", id).eq("org_id", orgId);
    if (deleteError) {
      console.error("save-quick-reply: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити швидку відповідь" });
    }
    return jsonResponse(200, { ok: true });
  }

  if (id) {
    const { data: reply, error: updateError } = await supabase
      .from("quick_replies")
      .update({ title, text })
      .eq("id", id)
      .eq("org_id", orgId)
      .select("id, title, text, created_at")
      .maybeSingle();

    if (updateError) {
      console.error("save-quick-reply: update failed", updateError);
      return jsonResponse(500, { error: "Не вдалося зберегти швидку відповідь" });
    }
    if (!reply) {
      return jsonResponse(404, { error: "Швидку відповідь не знайдено" });
    }
    return jsonResponse(200, { ok: true, reply });
  }

  const { data: reply, error: insertError } = await supabase
    .from("quick_replies")
    .insert({ org_id: orgId, title, text })
    .select("id, title, text, created_at")
    .single();

  if (insertError) {
    console.error("save-quick-reply: insert failed", insertError);
    return jsonResponse(500, { error: "Не вдалося створити швидку відповідь" });
  }

  return jsonResponse(200, { ok: true, reply });
};
