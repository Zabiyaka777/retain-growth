import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { pauseAiForManualSend } from "./_shared/pause-ai";
import { markBotBlocked } from "./_shared/bot-block";

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
  result?: { message_id?: number };
}

interface ThreadWithLead {
  id: string;
  channel_type: string;
  lead_id: string;
  leads: { external_id: string } | null;
}

// Manager-attached file — the same shape funnel-graph.ts/telegram-webhook.ts
// already write into messages.meta.attachments, restricted to the four types
// the chat's attach button actually offers (see Chats.tsx).
type AttachmentType = "photo" | "video" | "audio" | "document";
interface Attachment {
  type: AttachmentType;
  url: string;
  filename?: string;
}

// A small, local subset of funnel-graph.ts's own ATTACHMENT_METHODS table —
// deliberately not imported from there (that file's media-send logic already
// handles buttons/MarkdownV2/multi-attachment sequencing this endpoint has no
// use for, and CLAUDE.md keeps each function's behavior self-contained).
const TELEGRAM_ATTACHMENT_METHODS: Record<AttachmentType, string> = {
  photo: "sendPhoto",
  video: "sendVideo",
  audio: "sendAudio",
  document: "sendDocument",
};
const TELEGRAM_ATTACHMENT_FIELDS: Record<AttachmentType, string> = {
  photo: "photo",
  video: "video",
  audio: "audio",
  document: "document",
};

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
  let text: string | undefined;
  let attachments: Attachment[] | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    text = typeof body.text === "string" ? body.text.trim() : undefined;
    if (Array.isArray(body.attachments)) {
      attachments = body.attachments.filter(
        (a: unknown): a is Attachment =>
          !!a &&
          typeof a === "object" &&
          typeof (a as Attachment).url === "string" &&
          ["photo", "video", "audio", "document"].includes((a as Attachment).type),
      );
    }
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const hasAttachment = !!attachments && attachments.length > 0;
  if (!threadId || (!text && !hasAttachment)) {
    return jsonResponse(400, { error: "threadId і (text або attachments) обов'язкові" });
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

  // Confirms the thread actually belongs to the caller's org — a thread_id
  // for another organization must be rejected here, never trusted from the client.
  const { data: threadData, error: threadError } = await supabase
    .from("threads")
    .select("id, channel_type, lead_id, leads ( external_id )")
    .eq("id", threadId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (threadError || !threadData) {
    return jsonResponse(404, { error: "Тред не знайдено" });
  }

  const thread = threadData as unknown as ThreadWithLead;
  const chatId = thread.leads?.external_id;
  if (!chatId) {
    return jsonResponse(500, { error: "Не вдалося визначити отримувача" });
  }

  // A manager writing into a closed thread is itself the "this needs
  // attention again" signal — reopens it the same way new inbound activity
  // does in telegram-webhook.ts.
  const { error: reopenError } = await supabase
    .from("threads")
    .update({ status: "open" })
    .eq("id", threadId)
    .eq("status", "closed");
  if (reopenError) console.error("send-message: thread reopen failed", reopenError);

  // Parallel path: WhatsApp delegates to whatsapp-send.ts, which owns the
  // 24-hour window rule and records the message itself. The Telegram branch
  // below is untouched.
  if (thread.channel_type === "whatsapp") {
    const siteUrl = process.env.URL;
    if (!siteUrl) {
      return jsonResponse(500, { error: "URL сайту не сконфігуровано" });
    }

    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/whatsapp-send`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
        body: JSON.stringify({ threadId, text, attachments, sender: "agent", sentBy: userData.user.id }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; message?: unknown }
        | null;

      if (!res.ok) {
        return jsonResponse(res.status === 404 ? 404 : 502, { error: data?.error ?? "Не вдалося надіслати повідомлення" });
      }
      // A closed window is a real answer for the manager to read, not a
      // server error — 409 so the UI can show the "потрібен шаблон" text
      // rather than a generic failure.
      if (data?.ok === false) {
        return jsonResponse(409, { error: data.error ?? "Не вдалося надіслати повідомлення" });
      }

      return jsonResponse(200, { ok: true, message: data?.message ?? null });
    } catch {
      return jsonResponse(502, { error: "Мережева помилка. Спробуйте ще раз" });
    }
  }

  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", thread.channel_type)
    .maybeSingle();

  if (credentialError || !credential) {
    return jsonResponse(404, { error: "Канал не підключено" });
  }

  const { data: botToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });

  if (tokenError || !botToken) {
    console.error("send-message: vault_read_secret failed", tokenError);
    return jsonResponse(500, { error: "Не вдалося розшифрувати токен" });
  }

  // Exactly one attachment: the attach button in Chats.tsx offers one file
  // at a time, so anything beyond attachments[0] is ignored rather than
  // built out into funnel-graph.ts's multi-attachment sequencing (that logic
  // also carries buttons/MarkdownV2 this endpoint has no use for).
  const attachment = hasAttachment ? attachments![0] : null;
  const method = attachment ? TELEGRAM_ATTACHMENT_METHODS[attachment.type] : "sendMessage";
  const telegramBody: Record<string, unknown> = attachment
    ? { chat_id: chatId, [TELEGRAM_ATTACHMENT_FIELDS[attachment.type]]: attachment.url }
    : { chat_id: chatId, text };
  // Plain text, no parse_mode — same convention send-message.ts already uses
  // for a caption-less send: the manager's own words go out verbatim.
  if (attachment && text) telegramBody.caption = text;

  const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramBody),
  });
  const sendData = (await sendRes.json()) as TelegramApiResponse;

  if (!sendRes.ok || !sendData.ok) {
    console.error("send-message: Telegram send failed", sendData);
    // Reactive fallback — the manager's own send is a second, independent
    // chance to catch a block that my_chat_member (telegram-webhook.ts) may
    // have missed. Best effort: never blocks reporting the send failure.
    if (sendData.error_code === 403) {
      await markBotBlocked(supabase, orgId, thread.lead_id, true);
    }
    return jsonResponse(502, { error: sendData.description ?? "Не вдалося надіслати повідомлення" });
  }

  // A manager typing a reply by hand is itself "a human took over" — stop
  // every ai_active state on this thread so the lead's next message isn't
  // answered by both the manager and the model. Runs after the send is
  // already confirmed delivered, so a failure here never blocks or reverses
  // something the lead has already received.
  await pauseAiForManualSend(supabase, {
    orgId,
    threadId,
    leadId: thread.lead_id,
    actorUserId: userData.user.id,
    actorEmail: userData.user.email,
  });

  const { data: message, error: insertError } = await supabase
    .from("messages")
    .insert({
      org_id: orgId,
      thread_id: threadId,
      direction: "outbound",
      body: text ?? "",
      sender: "agent",
      sent_by: userData.user.id,
      meta: attachment ? { attachments: [attachment] } : null,
      // Telegram's id for this message — what edit-message.ts needs later.
      external_id: sendData.result?.message_id != null ? String(sendData.result.message_id) : null,
    })
    .select("id, body, direction, created_at, meta, sender, sent_by, external_id, edited_at")
    .single();

  if (insertError || !message) {
    // Telegram already delivered it — don't report failure, just skip echoing
    // the row back (the client will pick it up on next thread refresh).
    console.error("send-message: messages insert failed", insertError);
    return jsonResponse(200, { ok: true, message: null });
  }

  return jsonResponse(200, { ok: true, message });
};
