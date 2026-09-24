import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { markBotBlocked } from "./_shared/bot-block";
import { displayName } from "./_shared/activity-log";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
}

interface MessageWithThread {
  id: string;
  direction: string;
  sender: string | null;
  sent_by: string | null;
  external_id: string | null;
  meta: { attachments?: unknown[] } | null;
  threads: { channel_type: string; lead_id: string; leads: { external_id: string } | null } | null;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Edits a manager-sent Telegram message in place. Telegram only: the
// WhatsApp Cloud API has no edit operation for outbound business messages
// (its /messages endpoint only sends — verified against Meta's reference), so
// a WhatsApp thread is rejected here rather than emulated with delete+resend.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let messageId: string | undefined;
  let text: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    messageId = typeof body.messageId === "string" ? body.messageId : undefined;
    text = typeof body.text === "string" ? body.text.trim() : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!messageId || !text) {
    return jsonResponse(400, { error: "messageId і text обов'язкові" });
  }
  // Telegram's own cap for message text (captions are shorter, 1024 — checked below).
  if (text.length > 4096) {
    return jsonResponse(400, { error: "Текст завеликий (макс. 4096 символів)" });
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

  const { data: row, error: rowError } = await supabase
    .from("messages")
    .select("id, direction, sender, sent_by, external_id, meta, threads ( channel_type, lead_id, leads ( external_id ) )")
    .eq("id", messageId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (rowError || !row) {
    return jsonResponse(404, { error: "Повідомлення не знайдено" });
  }

  const message = row as unknown as MessageWithThread;
  const thread = message.threads;
  if (!thread || thread.channel_type !== "telegram") {
    return jsonResponse(400, { error: "Редагування доступне лише для Telegram" });
  }
  // Only the manager's own outbound messages — never the lead's, and never
  // funnel/AI messages (those may carry buttons that an edit would drop).
  if (message.direction !== "outbound" || message.sender !== "agent" || message.sent_by !== userData.user.id) {
    return jsonResponse(403, { error: "Можна редагувати лише власні повідомлення" });
  }
  if (!message.external_id) {
    return jsonResponse(409, { error: "Це повідомлення надіслано до появи редагування — змінити його неможливо" });
  }
  const chatId = thread.leads?.external_id;
  if (!chatId) {
    return jsonResponse(500, { error: "Не вдалося визначити отримувача" });
  }

  const hasAttachment = Array.isArray(message.meta?.attachments) && message.meta!.attachments!.length > 0;
  if (hasAttachment && text.length > 1024) {
    return jsonResponse(400, { error: "Підпис до файлу завеликий (макс. 1024 символи)" });
  }

  const { data: credential } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .maybeSingle();
  if (!credential) {
    return jsonResponse(404, { error: "Канал не підключено" });
  }

  const { data: botToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });
  if (tokenError || !botToken) {
    console.error("edit-message: vault_read_secret failed", tokenError);
    return jsonResponse(500, { error: "Не вдалося розшифрувати токен" });
  }

  // A message with a file carries its text as a caption — a different method.
  // Plain text, no parse_mode: same as send-message.ts, the manager's words go verbatim.
  const method = hasAttachment ? "editMessageCaption" : "editMessageText";
  const telegramBody: Record<string, unknown> = {
    chat_id: chatId,
    message_id: Number(message.external_id),
    [hasAttachment ? "caption" : "text"]: text,
  };

  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramBody),
  });
  const data = (await res.json()) as TelegramApiResponse;

  // Telegram rejects an edit that changes nothing; the stored text already
  // matches what the lead sees, so that's a success, not a failure.
  const notModified = !data.ok && /message is not modified/i.test(data.description ?? "");
  if ((!res.ok || !data.ok) && !notModified) {
    console.error("edit-message: Telegram edit failed", data);
    if (data.error_code === 403) {
      await markBotBlocked(supabase, orgId, thread.lead_id, true);
    }
    return jsonResponse(502, { error: data.description ?? "Не вдалося відредагувати повідомлення" });
  }

  const { data: updated, error: updateError } = await supabase
    .from("messages")
    // Only the author can edit (checked above), so this re-stamps the same
    // name — and fills it in on messages sent before sender_name existed.
    .update({ body: text, edited_at: new Date().toISOString(), sender_name: displayName(userData.user.email) })
    .eq("id", messageId)
    .eq("org_id", orgId)
    .select("id, body, direction, created_at, meta, transcript, sender, sent_by, sender_name, external_id, edited_at")
    .single();

  if (updateError || !updated) {
    // Telegram already shows the new text — report success without the row.
    console.error("edit-message: messages update failed", updateError);
    return jsonResponse(200, { ok: true, message: null });
  }

  return jsonResponse(200, { ok: true, message: updated });
};
