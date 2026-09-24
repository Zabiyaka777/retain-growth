import type { SupabaseClient } from "@supabase/supabase-js";
import { GRAPH_API_VERSION, loadWhatsAppCredential } from "./whatsapp";

// Purely perceptual UX — lets the lead see "typing…"/"read" while ai-respond
// waits on OpenRouter, without changing how long that wait actually is. Every
// network call in this module is try/caught internally: a failed typing
// signal must never affect, delay, or throw into the real reply that follows.

// Telegram (and FBM's Send API, same convention) auto-expires its own
// "typing" indicator after ~5s of no further signal, hence the repeat.
const REPEAT_MS = 4000;

export interface TypingIndicatorParams {
  channel: string;
  orgId: string;
  // Telegram: numeric chat id. FBM: PSID. Unused for WhatsApp (waMessageId
  // is what that channel's API needs instead).
  chatId?: string | null;
  // WhatsApp only — the inbound message's wamid, required by Cloud API's
  // mark-as-read + typing_indicator call.
  waMessageId?: string | null;
}

async function loadGenericBotToken(supabase: SupabaseClient, orgId: string, channelType: string): Promise<string | null> {
  const { data: credential, error } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", channelType)
    .maybeSingle();
  if (error || !credential?.bot_token_secret_id) return null;

  const { data: token, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });
  if (tokenError || !token) return null;
  return token as string;
}

async function sendTelegramTyping(token: string, chatId: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
    if (!res.ok) console.error("typing-indicator: telegram sendChatAction failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("typing-indicator: telegram sendChatAction threw", err);
  }
}

// One call covers both signals WhatsApp exposes for an inbound message: the
// read receipt and the typing bubble. Cloud API auto-clears this typing
// state after ~25s or as soon as the actual reply is sent — no repeat call
// needed, unlike Telegram/FBM.
async function sendWhatsAppReadAndTyping(accessToken: string, phoneNumberId: string, waMessageId: string): Promise<void> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: waMessageId,
        typing_indicator: { type: "text" },
      }),
    });
    if (!res.ok) console.error("typing-indicator: whatsapp mark-read+typing failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("typing-indicator: whatsapp request threw", err);
  }
}

async function sendFbmTyping(pageToken: string, psid: string): Promise<void> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, sender_action: "typing_on" }),
    });
    if (!res.ok) console.error("typing-indicator: fbm sender_action failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("typing-indicator: fbm sender_action threw", err);
  }
}

/**
 * Starts the right typing/read signal for the thread's channel and returns a
 * stop() to call once the wait it covers is over (the OpenRouter round —
 * there's no need to keep signaling once a reply is about to be sent).
 * Resolves to a no-op stop() whenever the channel isn't connected or isn't
 * recognized, so a caller never has to branch on whether this "worked".
 */
export async function startTypingIndicator(supabase: SupabaseClient, params: TypingIndicatorParams): Promise<() => void> {
  const { channel, orgId, chatId, waMessageId } = params;

  try {
    if (channel === "telegram" && chatId) {
      const token = await loadGenericBotToken(supabase, orgId, "telegram");
      if (!token) return () => {};
      void sendTelegramTyping(token, chatId);
      const interval = setInterval(() => void sendTelegramTyping(token, chatId), REPEAT_MS);
      return () => clearInterval(interval);
    }

    if (channel === "whatsapp" && waMessageId) {
      const credential = await loadWhatsAppCredential(supabase, orgId);
      if (!credential) return () => {};
      void sendWhatsAppReadAndTyping(credential.accessToken, credential.phoneNumberId, waMessageId);
      return () => {};
    }

    if (channel === "fbm" && chatId) {
      // No FBM webhook/send integration exists yet (see whatsapp-webhook.ts's
      // and telegram-webhook.ts's counterparts — there is no fbm-webhook.ts).
      // This resolves to a no-op today because no channel_credentials row
      // with channel_type='fbm' can exist, but is wired the same way as
      // Telegram/WhatsApp so it activates automatically once that channel is.
      const token = await loadGenericBotToken(supabase, orgId, "fbm");
      if (!token) return () => {};
      void sendFbmTyping(token, chatId);
      const interval = setInterval(() => void sendFbmTyping(token, chatId), REPEAT_MS);
      return () => clearInterval(interval);
    }
  } catch (err) {
    console.error("typing-indicator: startTypingIndicator threw", err);
  }

  return () => {};
}
