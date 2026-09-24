import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Shared WhatsApp Cloud API pieces. The Telegram equivalents live inline in
// their own functions; WhatsApp gets a module because the 24-hour window rule
// has to behave identically for every sender (funnel node, manager reply,
// AI hand-off), and duplicating that check is how it ends up drifting.

export const GRAPH_API_VERSION = "v19.0";

// Meta's customer service window: after an inbound message a business may
// reply with free-form content for 24 hours. Outside it only an approved
// template may be sent — free text is rejected by the API (and, more to the
// point, would be a policy violation even if it weren't).
export const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;

export const WINDOW_CLOSED_ERROR = "Вікно 24 години закрито, потрібен затверджений шаблон";

export interface WhatsAppCredential {
  access_token_secret_id: string;
  phone_number_id: string;
  waba_id: string | null;
}

export interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/**
 * Loads and decrypts an org's WhatsApp credentials. Returns null (already
 * logged) when the channel isn't connected or the token can't be read.
 */
export async function loadWhatsAppCredential(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ accessToken: string; phoneNumberId: string; wabaId: string | null } | null> {
  const { data: credential, error } = await supabase
    .from("channel_credentials")
    .select("access_token_secret_id, phone_number_id, waba_id")
    .eq("org_id", orgId)
    .eq("channel_type", "whatsapp")
    .maybeSingle();

  if (error || !credential?.access_token_secret_id || !credential.phone_number_id) {
    console.error("whatsapp: no active credential for org", orgId, error);
    return null;
  }

  const { data: accessToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.access_token_secret_id,
  });

  if (tokenError || !accessToken) {
    console.error("whatsapp: vault_read_secret failed", tokenError);
    return null;
  }

  return {
    accessToken: accessToken as string,
    phoneNumberId: credential.phone_number_id as string,
    wabaId: (credential.waba_id as string | null) ?? null,
  };
}

/**
 * True when free-form text may still be sent on this thread — i.e. the lead
 * wrote to us less than 24 hours ago.
 *
 * Read from `messages` rather than a cached column on threads: the transcript
 * is the source of truth for when the lead last wrote, and a denormalised
 * timestamp is one more thing that can silently fall out of sync and cause a
 * policy violation.
 */
export async function isWithinCustomerWindow(
  supabase: SupabaseClient,
  threadId: string,
): Promise<{ open: boolean; lastInboundAt: string | null }> {
  const { data, error } = await supabase
    .from("messages")
    .select("created_at")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("whatsapp: last inbound lookup failed", error);
    // Fail closed: an unknown window is treated as shut, because sending
    // outside it is the outcome that costs the org its WhatsApp standing.
    return { open: false, lastInboundAt: null };
  }

  if (!data) return { open: false, lastInboundAt: null };

  const lastInboundAt = data.created_at as string;
  const age = Date.now() - new Date(lastInboundAt).getTime();
  return { open: age <= CUSTOMER_WINDOW_MS, lastInboundAt };
}

/** Sends one free-form text message. The caller checks the window first. */
export async function sendWhatsAppText(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        // Link previews off: a funnel message's own wording is the content,
        // and an unfurled card would change how it reads.
        text: { preview_url: false, body: text },
      }),
    });

    const body = (await res.json().catch(() => null)) as (GraphErrorBody & { messages?: { id: string }[] }) | null;

    if (!res.ok) {
      console.error("whatsapp: send failed", res.status, body);
      return { ok: false, error: body?.error?.message ?? `Graph API ${res.status}` };
    }

    return { ok: true, messageId: body?.messages?.[0]?.id ?? null };
  } catch (err) {
    console.error("whatsapp: send request threw", err);
    return { ok: false, error: "Мережева помилка при зверненні до WhatsApp" };
  }
}

export type WhatsAppMediaType = "image" | "video" | "audio" | "document";

// WhatsApp's audio message type has no caption field at all (unlike
// image/video/document) — Meta silently drops it rather than erroring, but
// leaving it out here keeps the request honest about what will actually show.
const WHATSAPP_MEDIA_SUPPORTS_CAPTION: Record<WhatsAppMediaType, boolean> = {
  image: true,
  video: true,
  document: true,
  audio: false,
};

/**
 * Sends one media message by URL (Cloud API fetches it directly — the file
 * already lives in the same public "message-attachments" bucket every other
 * attachment path uses, so there's nothing to upload here). The caller
 * checks the 24-hour window first, same as sendWhatsAppText.
 */
export async function sendWhatsAppMedia(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  mediaType: WhatsAppMediaType,
  url: string,
  caption: string,
  filename?: string,
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const apiUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const mediaPayload: Record<string, unknown> = { link: url };
  if (caption && WHATSAPP_MEDIA_SUPPORTS_CAPTION[mediaType]) mediaPayload.caption = caption;
  if (mediaType === "document" && filename) mediaPayload.filename = filename;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: mediaType,
        [mediaType]: mediaPayload,
      }),
    });

    const body = (await res.json().catch(() => null)) as (GraphErrorBody & { messages?: { id: string }[] }) | null;

    if (!res.ok) {
      console.error("whatsapp: media send failed", res.status, body);
      return { ok: false, error: body?.error?.message ?? `Graph API ${res.status}` };
    }

    return { ok: true, messageId: body?.messages?.[0]?.id ?? null };
  } catch (err) {
    console.error("whatsapp: media send request threw", err);
    return { ok: false, error: "Мережева помилка при зверненні до WhatsApp" };
  }
}

/**
 * WhatsApp's own markup is a small subset of what the Telegram formatter
 * handles: *bold*, _italic_, ~strike~, ```mono```. The builder already stores
 * WhatsApp text with these marks, so the body goes out as-is — the important
 * part is that Telegram's MarkdownV2 escaping is NOT applied here, since its
 * backslashes would show up literally in WhatsApp.
 */
export function toWhatsAppText(text: string): string {
  return text;
}

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request body.
 * Compared in constant time, since a byte-by-byte early exit on a signature
 * check is exactly what a forgery attempt measures.
 */
export function verifyWebhookSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const provided = header.slice("sha256=".length);
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}
