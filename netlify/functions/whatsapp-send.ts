import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import {
  isWithinCustomerWindow,
  loadWhatsAppCredential,
  sendWhatsAppMedia,
  sendWhatsAppText,
  toWhatsAppText,
  WINDOW_CLOSED_ERROR,
  type WhatsAppMediaType,
} from "./_shared/whatsapp";
import { pauseAiForManualSend } from "./_shared/pause-ai";

// Same four types the chat's attach button offers (see Chats.tsx) — 'photo'
// is Telegram's naming for what WhatsApp calls 'image'.
type AttachmentType = "photo" | "video" | "audio" | "document";
interface Attachment {
  type: AttachmentType;
  url: string;
  filename?: string;
}
const TO_WHATSAPP_MEDIA_TYPE: Record<AttachmentType, WhatsAppMediaType> = {
  photo: "image",
  video: "video",
  audio: "audio",
  document: "document",
};

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

interface SendBody {
  threadId?: string;
  text?: string;
  /** Recorded on the stored message row: 'system' (funnel) or 'agent'. */
  sender?: "system" | "agent";
  /** Only set for an agent reply, so Chats can attribute it. */
  sentBy?: string | null;
  /** The manager's display name (send-message.ts derives it from their email). */
  senderName?: string | null;
  attachments?: Attachment[];
}

/**
 * Internal, service-to-service sender for WhatsApp — the counterpart of the
 * inline Telegram send calls, called by funnel-graph.ts and send-message.ts
 * so the 24-hour window rule is enforced in exactly one place.
 *
 * Guarded by the shared internal secret, the same way ai-respond.ts is: this
 * must never be reachable from a browser, since it sends on the org's behalf
 * without a user session.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const internalSecret = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  if (internalSecret !== serviceRoleKey) {
    console.error("whatsapp-send: rejected call without internal secret");
    return jsonResponse(401, { error: "Unauthorized" });
  }

  let body: SendBody;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter(
        (a): a is Attachment => !!a && typeof a === "object" && typeof a.url === "string" && ["photo", "video", "audio", "document"].includes(a.type),
      )
    : undefined;
  const hasAttachment = !!attachments && attachments.length > 0;
  if (!threadId || (!text && !hasAttachment)) {
    return jsonResponse(400, { error: "threadId і (text або attachments) обов'язкові" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: threadData, error: threadError } = await supabase
    .from("threads")
    .select("id, org_id, channel_type, lead_id, leads ( external_id )")
    .eq("id", threadId)
    .maybeSingle();

  if (threadError || !threadData) {
    return jsonResponse(404, { error: "Тред не знайдено" });
  }

  const thread = threadData as unknown as {
    id: string;
    org_id: string;
    channel_type: string;
    lead_id: string;
    leads: { external_id: string } | null;
  };

  if (thread.channel_type !== "whatsapp") {
    return jsonResponse(400, { error: "Тред не належить каналу WhatsApp" });
  }

  const to = thread.leads?.external_id;
  if (!to) {
    return jsonResponse(500, { error: "Не вдалося визначити отримувача" });
  }

  const orgId = thread.org_id;

  // The window check comes before the credential read on purpose: a closed
  // window is a normal, expected outcome, and there's no reason to decrypt a
  // token for a message that isn't going anywhere.
  const { open, lastInboundAt } = await isWithinCustomerWindow(supabase, threadId);
  if (!open) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "whatsapp_window_closed",
      level: "warn",
      payload: { thread_id: threadId, last_inbound_at: lastInboundAt, sender: body.sender ?? "system" },
    });
    if (eventError) console.error("whatsapp-send: events insert failed", eventError);

    // 200, not 4xx: the caller asked a legitimate question and got a
    // definite answer. A funnel walk must not treat this as a transport
    // failure and retry it forever.
    return jsonResponse(200, { ok: false, reason: "window_closed", error: WINDOW_CLOSED_ERROR, lastInboundAt });
  }

  const credential = await loadWhatsAppCredential(supabase, orgId);
  if (!credential) {
    return jsonResponse(404, { error: "WhatsApp не підключено" });
  }

  // Exactly one attachment: the attach button in Chats.tsx offers one file
  // at a time.
  const attachment = hasAttachment ? attachments![0] : null;
  const result = attachment
    ? await sendWhatsAppMedia(credential.accessToken, credential.phoneNumberId, to, TO_WHATSAPP_MEDIA_TYPE[attachment.type], attachment.url, text, attachment.filename)
    : await sendWhatsAppText(credential.accessToken, credential.phoneNumberId, to, toWhatsAppText(text));

  if (!result.ok) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "whatsapp_send_failed",
      level: "error",
      payload: { thread_id: threadId, error: result.error },
    });
    if (eventError) console.error("whatsapp-send: events insert failed", eventError);
    return jsonResponse(502, { error: result.error });
  }

  // Only a manager's own reply counts as "a human took over" — funnel-graph.ts
  // calls this same function for the funnel's own automated sends
  // (sender:'system'), which must not pause anything. Same approach as
  // send-message.ts's Telegram branch, and for the same reason.
  if (body.sender === "agent") {
    await pauseAiForManualSend(supabase, {
      orgId,
      threadId,
      leadId: thread.lead_id,
      actorUserId: body.sentBy ?? null,
    });
  }

  const { data: message, error: insertError } = await supabase
    .from("messages")
    .insert({
      org_id: orgId,
      thread_id: threadId,
      direction: "outbound",
      body: text,
      sender: body.sender ?? "system",
      sent_by: body.sentBy ?? null,
      sender_name: body.sender === "agent" && typeof body.senderName === "string" ? body.senderName.slice(0, 80) : null,
      meta: attachment ? { attachments: [attachment] } : null,
    })
    .select("id, body, direction, created_at, meta, sender, sent_by, sender_name")
    .single();

  if (insertError) {
    // WhatsApp already delivered it — report success and skip echoing the
    // row, same call the Telegram sender makes in this situation.
    console.error("whatsapp-send: messages insert failed", insertError);
    return jsonResponse(200, { ok: true, message: null, waMessageId: result.messageId });
  }

  return jsonResponse(200, { ok: true, message, waMessageId: result.messageId });
};
