import type { SupabaseClient } from "@supabase/supabase-js";

// Shared Instagram (Meta Graph API) pieces — the Instagram counterpart of
// _shared/whatsapp.ts. Credential loading and the outbound Graph API calls
// live here so ai-respond.ts, send-message.ts and _shared/funnel-graph.ts
// all send through the exact same code instead of three drifting copies.
// Signature verification is NOT duplicated here — instagram-webhook.ts
// imports verifyWebhookSignature straight from ./whatsapp, since it's plain
// HMAC-SHA256 over the raw body with nothing WhatsApp-specific about it.

export const GRAPH_API_VERSION = "v21.0";

export interface InstagramCredential {
  accessToken: string;
  igBusinessAccountId: string;
  pageId: string;
}

export interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/**
 * Loads and decrypts an org's Instagram credentials. Returns null (already
 * logged) when the channel isn't connected or the token can't be read —
 * same contract as _shared/whatsapp.ts's loadWhatsAppCredential.
 */
export async function loadInstagramCredential(
  supabase: SupabaseClient,
  orgId: string,
): Promise<InstagramCredential | null> {
  const { data: credential, error } = await supabase
    .from("channel_credentials")
    .select("access_token_secret_id, instagram_business_account_id, page_id")
    .eq("org_id", orgId)
    .eq("channel_type", "instagram")
    .maybeSingle();

  if (error || !credential?.access_token_secret_id || !credential.instagram_business_account_id || !credential.page_id) {
    console.error("instagram: no active credential for org", orgId, error);
    return null;
  }

  const { data: accessToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.access_token_secret_id,
  });

  if (tokenError || !accessToken) {
    console.error("instagram: vault_read_secret failed", tokenError);
    return null;
  }

  return {
    accessToken: accessToken as string,
    igBusinessAccountId: credential.instagram_business_account_id as string,
    pageId: credential.page_id as string,
  };
}

// Instagram DM buttons (Meta's Send API, shared with Messenger): up to 3
// persistent "base" buttons rendered as a button template, OR up to 10
// ephemeral quick replies attached to the same message — never both meaning
// the same thing, so the caller picks which array a given FunnelButton goes
// into (see toInstagramButtons in _shared/funnel-graph.ts).
export const MAX_BASE_BUTTONS = 3;
export const MAX_QUICK_REPLIES = 10;

export interface InstagramBaseButton {
  type: "web_url" | "postback";
  title: string;
  url?: string;
  payload?: string;
}

export interface InstagramQuickReply {
  content_type: "text";
  title: string;
  payload: string;
}

interface SendResult {
  ok: boolean;
  messageId?: string | null;
  error?: string;
}

async function callInstagramSendApi(accessToken: string, body: Record<string, unknown>): Promise<SendResult> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as (GraphErrorBody & { message_id?: string }) | null;
    if (!res.ok) {
      console.error("instagram: send failed", res.status, data);
      return { ok: false, error: data?.error?.message ?? `Graph API ${res.status}` };
    }
    return { ok: true, messageId: data?.message_id ?? null };
  } catch (err) {
    console.error("instagram: send request threw", err);
    return { ok: false, error: "Мережева помилка при зверненні до Instagram" };
  }
}

/**
 * Sends a normal DM to an IG-scoped user id — the ordinary funnel/manager/AI
 * reply path. `baseButtons` (max 3) render as a persistent button template
 * attached to the text; `quickReplies` (max 10) render as one-tap chips that
 * vanish after the lead's next message. Never send both non-empty at once —
 * Meta's button template already carries its own text, so a message with
 * base buttons ignores `text` as a separate bubble; the caller decides which
 * one a given node uses (funnel-graph.ts picks based on which buttons exist).
 */
export async function sendInstagramMessage(
  accessToken: string,
  recipientId: string,
  text: string,
  baseButtons?: InstagramBaseButton[],
  quickReplies?: InstagramQuickReply[],
): Promise<SendResult> {
  const message: Record<string, unknown> =
    baseButtons && baseButtons.length > 0
      ? {
          attachment: {
            type: "template",
            payload: { template_type: "button", text: text.slice(0, 640), buttons: baseButtons.slice(0, MAX_BASE_BUTTONS) },
          },
        }
      : { text };

  if (quickReplies && quickReplies.length > 0) {
    message.quick_replies = quickReplies.slice(0, MAX_QUICK_REPLIES);
  }

  return callInstagramSendApi(accessToken, { recipient: { id: recipientId }, message });
}

/**
 * The mandatory first DM off a matched comment (ТЗ business rule: it MUST
 * carry a button — enforced by the caller, not here, since only the caller
 * knows whether the referenced funnel node has any). `recipient.comment_id`
 * is Meta's "private reply" addressing — the only way to DM someone who
 * hasn't messaged the account yet, valid for a limited window after their
 * comment. This never touches leads/threads; see instagram_pending_dm_entries.
 */
export async function sendInstagramPrivateReply(
  accessToken: string,
  commentId: string,
  text: string,
  baseButtons: InstagramBaseButton[],
): Promise<SendResult> {
  const message =
    baseButtons.length > 0
      ? { attachment: { type: "template", payload: { template_type: "button", text: text.slice(0, 640), buttons: baseButtons.slice(0, MAX_BASE_BUTTONS) } } }
      : { text };
  return callInstagramSendApi(accessToken, { recipient: { comment_id: commentId }, message });
}

/** Posts a public reply under the triggering comment itself. */
export async function postInstagramCommentReply(accessToken: string, commentId: string, text: string): Promise<SendResult> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ message: text }),
    });
    const data = (await res.json().catch(() => null)) as (GraphErrorBody & { id?: string }) | null;
    if (!res.ok) {
      console.error("instagram: comment reply failed", res.status, data);
      return { ok: false, error: data?.error?.message ?? `Graph API ${res.status}` };
    }
    return { ok: true, messageId: data?.id ?? null };
  } catch (err) {
    console.error("instagram: comment reply request threw", err);
    return { ok: false, error: "Мережева помилка при зверненні до Instagram" };
  }
}

/**
 * Best-effort — Meta's exact like/unlike contract for a story reply or
 * mention isn't fully confirmed against live docs yet (see connect-instagram.ts
 * header comment); wired against the documented Graph API "like" edge and
 * never allowed to fail the caller's own flow. Verify against the real app
 * before relying on it.
 */
export async function tryAutoLikeInstagramMedia(accessToken: string, mediaId: string): Promise<void> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}/likes`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) console.error("instagram: auto-like failed", res.status, await res.text());
  } catch (err) {
    console.error("instagram: auto-like request threw", err);
  }
}

/** true/false/undefined matcher: include must have ≥1 hit (if any given), exclude must have 0 hits. */
export function matchesKeywordFilters(text: string, include: string[], exclude: string[]): boolean {
  const lower = text.toLowerCase();
  if (exclude.some((kw) => kw && lower.includes(kw.toLowerCase()))) return false;
  if (include.length === 0) return true;
  return include.some((kw) => kw && lower.includes(kw.toLowerCase()));
}

/** Picks one reply text at random — comment auto-replies rotate so the same
 * wording doesn't appear under every matching comment (a Meta spam signal). */
export function pickRandomVariant(variants: string[]): string | null {
  const usable = variants.filter((v) => v && v.trim());
  if (usable.length === 0) return null;
  return usable[Math.floor(Math.random() * usable.length)];
}
