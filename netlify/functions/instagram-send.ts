import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import {
  loadInstagramCredential,
  sendInstagramMessage,
  type InstagramBaseButton,
  type InstagramQuickReply,
} from "./_shared/instagram";
import { pauseAiForManualSend } from "./_shared/pause-ai";

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
  // Pre-translated by the caller (_shared/funnel-graph.ts's toInstagramButtons)
  // — this file stays ignorant of FunnelButton/actionType, same separation
  // whatsapp-send.ts keeps from the funnel graph's own types.
  baseButtons?: InstagramBaseButton[];
  quickReplies?: InstagramQuickReply[];
}

/**
 * Internal, service-to-service sender for Instagram — the Instagram
 * counterpart of whatsapp-send.ts. Called by funnel-graph.ts, send-message.ts
 * and ai-respond.ts so every outbound path shares one Graph API call and one
 * place that records the outbound row.
 *
 * Guarded by the shared internal secret, the same way whatsapp-send.ts is:
 * this must never be reachable from a browser.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const internalSecret = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  if (internalSecret !== serviceRoleKey) {
    console.error("instagram-send: rejected call without internal secret");
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
  const baseButtons = Array.isArray(body.baseButtons) ? body.baseButtons : undefined;
  const quickReplies = Array.isArray(body.quickReplies) ? body.quickReplies : undefined;
  if (!threadId || !text) {
    return jsonResponse(400, { error: "threadId і text обов'язкові" });
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

  if (thread.channel_type !== "instagram") {
    return jsonResponse(400, { error: "Тред не належить каналу Instagram" });
  }

  const recipientId = thread.leads?.external_id;
  if (!recipientId) {
    return jsonResponse(500, { error: "Не вдалося визначити отримувача" });
  }

  const orgId = thread.org_id;

  const credential = await loadInstagramCredential(supabase, orgId);
  if (!credential) {
    return jsonResponse(404, { error: "Instagram не підключено" });
  }

  const result = await sendInstagramMessage(credential.accessToken, recipientId, text, baseButtons, quickReplies);

  if (!result.ok) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "instagram_send_failed",
      level: "error",
      payload: { thread_id: threadId, error: result.error },
    });
    if (eventError) console.error("instagram-send: events insert failed", eventError);
    return jsonResponse(502, { error: result.error });
  }

  // Only a manager's own reply counts as "a human took over" — funnel-graph.ts
  // calls this same function for the funnel's own automated sends
  // (sender:'system'), which must not pause anything. Same approach as
  // send-message.ts's Telegram/WhatsApp branches.
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
      meta:
        (baseButtons && baseButtons.length > 0) || (quickReplies && quickReplies.length > 0)
          ? { buttons: [...(baseButtons ?? []), ...(quickReplies ?? [])].map((b) => ({ label: b.title })) }
          : null,
    })
    .select("id, body, direction, created_at, meta, sender, sent_by, sender_name")
    .single();

  if (insertError) {
    // Instagram already delivered it — report success and skip echoing the
    // row, same call the WhatsApp sender makes in this situation.
    console.error("instagram-send: messages insert failed", insertError);
    return jsonResponse(200, { ok: true, message: null, igMessageId: result.messageId });
  }

  return jsonResponse(200, { ok: true, message, igMessageId: result.messageId });
};
