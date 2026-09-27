import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyWebhookSignature } from "./_shared/whatsapp";
import {
  loadInstagramCredential,
  matchesKeywordFilters,
  pickRandomVariant,
  postInstagramCommentReply,
  sendInstagramPrivateReply,
  tryAutoLikeInstagramMedia,
  type InstagramBaseButton,
} from "./_shared/instagram";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ---------------------------------------------------------------------------
// Meta Graph API envelope. Instagram DMs/postbacks arrive on entry.messaging
// (the same shape Messenger Platform uses); comments and story engagement
// arrive on entry.changes, one "field" per event kind. A single webhook call
// can and does carry more than one entry / more than one event per entry.
// ---------------------------------------------------------------------------

interface IgMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    quick_reply?: { payload?: string };
    // Present when this message is a reply to one of OUR stories.
    reply_to?: { story?: { id?: string; url?: string } };
    is_echo?: boolean;
  };
  postback?: { mid?: string; payload?: string; title?: string };
}

interface IgChangeValue {
  // comments: the comment itself.
  id?: string;
  text?: string;
  media?: { id?: string; media_product_type?: string };
  from?: { id?: string; username?: string };
  // mentions: which of our media the account was tagged/mentioned on.
  media_id?: string;
  comment_id?: string;
}

interface IgChange {
  field?: string;
  value?: IgChangeValue;
}

interface IgEntry {
  id?: string;
  time?: number;
  messaging?: IgMessaging[];
  changes?: IgChange[];
}

interface IgWebhookPayload {
  object?: string;
  entry?: IgEntry[];
}

function jsonResponse200() {
  return { statusCode: 200, body: "OK" };
}

// ---------------------------------------------------------------------------
// Idempotency — mirrors telegram-webhook.ts's processed_telegram_updates
// gate exactly (atomic insert, unique-constraint-backed, 23505 = duplicate).
// event_id is synthesized per event kind since Meta gives each a different
// natural key (see call sites below).
// ---------------------------------------------------------------------------

async function claimEvent(supabase: SupabaseClient, orgId: string, eventId: string): Promise<boolean> {
  const { error } = await supabase.from("processed_instagram_updates").insert({ org_id: orgId, event_id: eventId });
  if (!error) return true;
  if (error.code === "23505") return false;
  // Any other error is a dedup-bookkeeping failure, not evidence of a
  // duplicate — better to risk an occasional double-send than to drop a
  // lead's message because this table had a hiccup (same call telegram-
  // webhook.ts makes).
  console.error("instagram-webhook: dedup insert failed, processing anyway", eventId, error);
  return true;
}

interface ThreadResult {
  threadId: string;
  leadId: string;
  isNewLead: boolean;
  suppressed: boolean;
}

/** Upserts lead+thread for an inbound DM sender — mirrors telegram-webhook.ts. */
async function resolveThread(supabase: SupabaseClient, orgId: string, igUserId: string, username: string | null): Promise<ThreadResult | null> {
  const { data: existingLead } = await supabase
    .from("leads")
    .select("id")
    .eq("org_id", orgId)
    .eq("channel_type", "instagram")
    .eq("external_id", igUserId)
    .maybeSingle();
  const isNewLead = !existingLead;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .upsert({ org_id: orgId, channel_type: "instagram", external_id: igUserId, username }, { onConflict: "org_id,channel_type,external_id" })
    .select("id, status")
    .single();

  if (leadError || !lead) {
    console.error("instagram-webhook: failed to upsert lead", leadError);
    return null;
  }

  const { data: thread, error: threadError } = await supabase
    .from("threads")
    .upsert({ org_id: orgId, lead_id: lead.id, channel_type: "instagram" }, { onConflict: "lead_id,channel_type" })
    .select("id")
    .single();

  if (threadError || !thread) {
    console.error("instagram-webhook: failed to upsert thread", threadError);
    return null;
  }

  // New activity always reopens a closed thread, same as telegram-webhook.ts.
  const { error: reopenError } = await supabase.from("threads").update({ status: "open" }).eq("id", thread.id).eq("status", "closed");
  if (reopenError) console.error("instagram-webhook: thread reopen failed", reopenError);

  return { threadId: thread.id, leadId: lead.id, isNewLead, suppressed: lead.status === "blocked" || lead.status === "archived" };
}

/** Fire-and-forget hand-offs — identical shape to telegram-webhook.ts's. */
async function notifyNewMessage(orgId: string, threadId: string, title: string, bodyText: string) {
  const siteUrl = process.env.URL;
  if (!siteUrl) return;
  try {
    await fetch(`${siteUrl}/.netlify/functions/send-push-notification-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
      body: JSON.stringify({ orgId, threadId, title, body: bodyText }),
    });
  } catch (err) {
    console.error("instagram-webhook: push notification invoke failed", err);
  }
}

async function triggerAiIfActive(supabase: SupabaseClient, orgId: string, threadId: string, userText: string, inboundMessageId: string | null) {
  const { data: aiStates } = await supabase
    .from("funnel_states")
    .select("id")
    .eq("thread_id", threadId)
    .eq("status", "ai_active")
    .order("created_at", { ascending: false });
  const aiState = aiStates?.[0];
  if (!aiState) return false;

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    console.error("instagram-webhook: URL сайту не сконфігуровано, не можу викликати ai-respond");
    return true;
  }
  try {
    await fetch(`${siteUrl}/.netlify/functions/ai-respond-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
      body: JSON.stringify({ threadId, stateId: aiState.id, userText, inboundMessageId }),
    });
  } catch (err) {
    console.error("instagram-webhook: ai-respond invoke failed", err);
  }
  return true;
}

async function advanceButton(threadId: string, chosenButtonId: string) {
  const siteUrl = process.env.URL;
  if (!siteUrl) {
    console.error("instagram-webhook: URL сайту не сконфігуровано, не можу викликати funnel-advance");
    return;
  }
  try {
    await fetch(`${siteUrl}/.netlify/functions/funnel-advance-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, chosenButtonId }),
    });
  } catch (err) {
    console.error("instagram-webhook: funnel-advance invoke failed", err);
  }
}

/**
 * Hands a just-placed funnel_states row to funnel-advance-background so the
 * node it's on runs now instead of waiting for the next cron pass — used
 * wherever this file places a lead onto a specific node itself (new-lead
 * enrollment, a story-reply match), never for an ordinary button tap
 * (advanceButton above covers that via chosenButtonId + claim_specific_*).
 */
async function advanceFreshPlacement(supabase: SupabaseClient, threadId: string, funnelId: string) {
  const siteUrl = process.env.URL;
  if (!siteUrl) return;
  const { data: state } = await supabase.from("funnel_states").select("id").eq("thread_id", threadId).eq("funnel_id", funnelId).maybeSingle();
  if (!state) return;
  try {
    await fetch(`${siteUrl}/.netlify/functions/funnel-advance-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stateId: state.id, freshPlacement: true }),
    });
  } catch (err) {
    console.error("instagram-webhook: funnel-advance invoke failed", err);
  }
}

/**
 * Enrolls a brand-new lead into a funnel: first checks for a pending private-
 * reply bridge left by the comment-trigger path (see
 * instagram_pending_dm_entries), then falls back to the org's oldest active
 * funnel — same two-tier shape as telegram-webhook.ts's /start vs. organic
 * new-lead handling, just collapsed into one function since Instagram has no
 * deep-link payload to branch on first.
 */
async function enrollNewLead(supabase: SupabaseClient, orgId: string, threadId: string, igUserId: string) {
  const { data: pending } = await supabase
    .from("instagram_pending_dm_entries")
    .select("funnel_node_id")
    .eq("org_id", orgId)
    .eq("ig_user_id", igUserId)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  let funnelNodeId: string | null = null;
  let funnelId: string | null = null;

  if (pending?.funnel_node_id) {
    const { data: node } = await supabase.from("funnel_nodes").select("id, funnel_id").eq("id", pending.funnel_node_id).maybeSingle();
    if (node) {
      funnelNodeId = node.id as string;
      funnelId = node.funnel_id as string;
    }
    // Consumed whether or not the node still resolves — a stale/deleted node
    // must not keep re-matching on every later message from this same user.
    await supabase.from("instagram_pending_dm_entries").delete().eq("org_id", orgId).eq("ig_user_id", igUserId);
  }

  if (!funnelNodeId || !funnelId) {
    const { data: funnel } = await supabase
      .from("funnels")
      .select("id")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!funnel) return;
    funnelId = funnel.id as string;
    // No specific node: land on the funnel's own entry node the normal way
    // (funnel-advance-background resolves it once current_step/funnel_node_id
    // is null and status is 'active' — mirrors funnel-processor-v2.ts's claim).
  }

  const { error: stateError } = await supabase.from("funnel_states").upsert(
    {
      thread_id: threadId,
      org_id: orgId,
      funnel_id: funnelId,
      funnel_node_id: funnelNodeId,
      current_step: 0,
      waiting_until: new Date().toISOString(),
      status: "active",
    },
    { onConflict: "thread_id,funnel_id" },
  );
  if (stateError) {
    console.error("instagram-webhook: funnel_states upsert failed", stateError);
    return;
  }

  // No funnel_node_id: leaves the row for the legacy current_step cron
  // (claim_due_funnel_states) to pick up, same as telegram-webhook.ts's own
  // organic-new-lead fallback — nothing to advance immediately.
  if (funnelNodeId) await advanceFreshPlacement(supabase, threadId, funnelId);
}

// ---------------------------------------------------------------------------
// Comments → DM (ТЗ item 3). Hardcoded, not optional: leads/threads are never
// touched here — only once the commenter replies to the private-reply DM (or
// taps its button) does the normal messaging[] path above create them. That
// path is also the only place instagram_pending_dm_entries gets consumed.
// ---------------------------------------------------------------------------

async function handleCommentEvent(supabase: SupabaseClient, orgId: string, credentialAccessToken: string, change: IgChangeValue) {
  const commentId = change.id;
  const text = change.text ?? "";
  const commenterId = change.from?.id;
  const mediaId = change.media?.id;
  if (!commentId || !commenterId) return;

  const { data: triggers, error } = await supabase
    .from("instagram_comment_triggers")
    .select("id, scope, media_id, include_keywords, exclude_keywords, reply_variants, dm_funnel_node_id")
    .eq("org_id", orgId)
    .eq("is_active", true);
  if (error) {
    console.error("instagram-webhook: comment triggers lookup failed", error);
    return;
  }

  const trigger = (triggers ?? []).find((t) => {
    if (t.scope === "specific_post" && t.media_id !== mediaId) return false;
    // 'all_lives' vs 'all_posts' can't be told apart from the comment payload
    // alone without an extra media-details call — both scopes match any
    // non-specific comment for now; narrow this once media_product_type is
    // confirmed reliable against the live app.
    return matchesKeywordFilters(text, t.include_keywords ?? [], t.exclude_keywords ?? []);
  });
  if (!trigger) return;

  const replyText = pickRandomVariant(trigger.reply_variants ?? []);
  if (replyText) {
    const publicReply = await postInstagramCommentReply(credentialAccessToken, commentId, replyText);
    if (!publicReply.ok) {
      await supabase.from("events").insert({
        org_id: orgId,
        type: "instagram_comment_reply_failed",
        level: "error",
        payload: { comment_id: commentId, trigger_id: trigger.id, error: publicReply.error },
      });
    }
  }

  // Hardcoded rule (ТЗ item 3): refuse to send a DM with no button rather
  // than silently sending text-only — an account that DMs commenters without
  // one risks a Meta ban. dm_funnel_node_id's own config supplies both the
  // button and the DM's text.
  if (!trigger.dm_funnel_node_id) {
    await supabase.from("events").insert({
      org_id: orgId,
      type: "instagram_comment_dm_not_configured",
      level: "warn",
      payload: { comment_id: commentId, trigger_id: trigger.id },
    });
    return;
  }

  const { data: node } = await supabase.from("funnel_nodes").select("config, funnel_id").eq("id", trigger.dm_funnel_node_id).maybeSingle();
  const config = (node?.config ?? {}) as { channels?: { instagram?: { blocks?: { kind?: string; text?: string }[] } }; buttons?: { id: string; label: string; actionType?: string; url?: string }[] };
  const buttons = (config.buttons ?? []).filter((b) => b.label);
  const dmText = config.channels?.instagram?.blocks?.find((b) => b.kind === "text")?.text?.trim();

  if (buttons.length === 0 || !dmText) {
    await supabase.from("events").insert({
      org_id: orgId,
      type: "instagram_comment_dm_missing_button",
      level: "error",
      payload: { comment_id: commentId, trigger_id: trigger.id, node_id: trigger.dm_funnel_node_id, reason: buttons.length === 0 ? "no_button" : "no_text" },
    });
    return;
  }

  const baseButtons: InstagramBaseButton[] = buttons.slice(0, 3).map((b) => (b.actionType === "link" && b.url ? { type: "web_url", title: b.label, url: b.url } : { type: "postback", title: b.label, payload: b.id }));

  const dmResult = await sendInstagramPrivateReply(credentialAccessToken, commentId, dmText, baseButtons);
  if (!dmResult.ok) {
    await supabase.from("events").insert({
      org_id: orgId,
      type: "instagram_comment_dm_failed",
      level: "error",
      payload: { comment_id: commentId, trigger_id: trigger.id, error: dmResult.error },
    });
    return;
  }

  await supabase.from("instagram_pending_dm_entries").upsert(
    { org_id: orgId, ig_user_id: commenterId, funnel_node_id: trigger.dm_funnel_node_id, source_comment_trigger_id: trigger.id },
    { onConflict: "org_id,ig_user_id" },
  );

  await supabase.from("events").insert({
    org_id: orgId,
    type: "instagram_comment_private_reply_sent",
    level: "info",
    payload: { comment_id: commentId, commenter_ig_id: commenterId, trigger_id: trigger.id },
  });
}

// ---------------------------------------------------------------------------
// Stories (ТЗ item 4). A reply to our own story arrives on entry.messaging
// (handled inline in the main loop below, since it's already a DM). A
// mention of our account in someone else's story arrives here instead — it
// has no messaging-window guarantee, so it can auto-like but does not enroll
// anyone into a funnel (there is no private-reply-to-mention API to bridge
// through, unlike comments).
// ---------------------------------------------------------------------------

async function handleMentionEvent(supabase: SupabaseClient, orgId: string, credentialAccessToken: string, change: IgChangeValue) {
  const mediaId = change.media_id;
  if (!mediaId) return;

  const { data: triggers, error } = await supabase
    .from("instagram_story_triggers")
    .select("id, react_to_mention, scope, story_media_id, active_from, active_until, auto_like")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .eq("react_to_mention", true);
  if (error) {
    console.error("instagram-webhook: story triggers lookup failed", error);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const trigger = (triggers ?? []).find((t) => {
    if (t.scope === "specific_story" && t.story_media_id !== mediaId) return false;
    if (t.active_from && today < t.active_from) return false;
    if (t.active_until && today > t.active_until) return false;
    return true;
  });
  if (!trigger) return;

  if (trigger.auto_like) await tryAutoLikeInstagramMedia(credentialAccessToken, mediaId);

  await supabase.from("events").insert({
    org_id: orgId,
    type: "instagram_story_mention_matched",
    level: "info",
    payload: { media_id: mediaId, trigger_id: trigger.id },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event) => {
  // Same org-id-in-path shape as telegram-webhook.ts/whatsapp-webhook.ts.
  const orgId = event.path.split("/instagram-webhook/")[1] ?? null;
  if (!orgId) {
    console.error("instagram-webhook: missing org_id in path", event.path);
    return jsonResponse200();
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: credentialRow, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("webhook_secret_id, app_secret_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "instagram")
    .maybeSingle();

  if (credentialError || !credentialRow) {
    console.error("instagram-webhook: no active instagram credential for org", orgId);
    return jsonResponse200();
  }

  const { data: expectedSecret } = credentialRow.webhook_secret_id
    ? await supabase.rpc("vault_read_secret", { secret_id: credentialRow.webhook_secret_id })
    : { data: null };

  // Meta verifies a webhook URL once with a GET carrying hub.challenge —
  // identical handshake to whatsapp-webhook.ts.
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters ?? {};
    if (params["hub.mode"] === "subscribe" && expectedSecret && params["hub.verify_token"] === expectedSecret) {
      return { statusCode: 200, body: params["hub.challenge"] ?? "" };
    }
    console.error("instagram-webhook: verify token mismatch", { orgId });
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { data: appSecret } = credentialRow.app_secret_secret_id
    ? await supabase.rpc("vault_read_secret", { secret_id: credentialRow.app_secret_secret_id })
    : { data: null };

  if (!appSecret) {
    console.error("instagram-webhook: no app secret stored, cannot verify signature", { orgId });
    return jsonResponse200();
  }

  const signature = event.headers["x-hub-signature-256"] ?? event.headers["X-Hub-Signature-256"];
  if (!verifyWebhookSignature(event.body ?? "", signature, appSecret as string)) {
    console.error("instagram-webhook: signature mismatch, rejecting silently", { orgId });
    return jsonResponse200();
  }

  let payload: IgWebhookPayload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse200();
  }

  // The Graph API credential (access token) is only decrypted once, and only
  // when this call actually needs to send something (a comment reply/DM/
  // auto-like) — most webhook deliveries are plain inbound DMs, which reuse
  // the pre-existing send-message.ts→instagram-send.ts path instead.
  let sendCredential: string | null = null;
  async function accessTokenForSending(): Promise<string | null> {
    if (sendCredential) return sendCredential;
    const credential = await loadInstagramCredential(supabase, orgId as string);
    sendCredential = credential?.accessToken ?? null;
    return sendCredential;
  }

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      if (messaging.message?.is_echo) continue; // our own sent messages, echoed back
      const senderId = messaging.sender?.id;
      if (!senderId) continue;

      const mid = messaging.message?.mid;
      const postback = messaging.postback;
      const eventId = mid ? `msg:${mid}` : postback ? `pb:${senderId}:${messaging.timestamp ?? Date.now()}` : null;
      if (eventId && !(await claimEvent(supabase, orgId, eventId))) continue;

      const text = messaging.message?.text ?? postback?.title ?? null;
      const buttonId = postback?.payload ?? messaging.message?.quick_reply?.payload ?? null;
      if (!text && !buttonId) continue;

      const thread = await resolveThread(supabase, orgId, senderId, null);
      if (!thread) continue;

      const { data: inboundMessage } = await supabase
        .from("messages")
        .insert({ org_id: orgId, thread_id: thread.threadId, direction: "inbound", body: text })
        .select("id")
        .single();

      const { error: unreadError } = await supabase.rpc("increment_thread_unread", { p_thread_id: thread.threadId });
      if (unreadError) console.error("instagram-webhook: increment_thread_unread failed", unreadError);

      await notifyNewMessage(orgId, thread.threadId, "Новий лід · Instagram", text ?? "Надіслав(ла) файл");

      if (thread.suppressed) {
        await supabase.from("events").insert({
          org_id: orgId,
          type: "blocked_lead_ignored",
          level: "info",
          payload: { source: "instagram-webhook", thread_id: thread.threadId, lead_id: thread.leadId },
        });
        continue;
      }

      // Story reply to us: matched against instagram_story_triggers same as
      // a mention, but inline here since it's already a DM — no pending-entry
      // bridge needed, this can enroll immediately.
      const storyId = messaging.message?.reply_to?.story?.id;
      if (storyId) {
        const { data: storyTriggers } = await supabase
          .from("instagram_story_triggers")
          .select("id, scope, story_media_id, active_from, active_until, auto_like, include_keywords, exclude_keywords, reply_funnel_node_id")
          .eq("org_id", orgId)
          .eq("is_active", true)
          .eq("react_to_reply", true);
        const today = new Date().toISOString().slice(0, 10);
        const storyTrigger = (storyTriggers ?? []).find((t) => {
          if (t.scope === "specific_story" && t.story_media_id !== storyId) return false;
          if (t.active_from && today < t.active_from) return false;
          if (t.active_until && today > t.active_until) return false;
          return matchesKeywordFilters(text ?? "", t.include_keywords ?? [], t.exclude_keywords ?? []);
        });
        if (storyTrigger) {
          if (storyTrigger.auto_like) {
            const token = await accessTokenForSending();
            if (token) await tryAutoLikeInstagramMedia(token, storyId);
          }
          if (storyTrigger.reply_funnel_node_id && thread.isNewLead) {
            const { data: node } = await supabase.from("funnel_nodes").select("funnel_id").eq("id", storyTrigger.reply_funnel_node_id).maybeSingle();
            if (node) {
              await supabase.from("funnel_states").upsert(
                {
                  thread_id: thread.threadId,
                  org_id: orgId,
                  funnel_id: node.funnel_id,
                  funnel_node_id: storyTrigger.reply_funnel_node_id,
                  current_step: 0,
                  waiting_until: new Date().toISOString(),
                  status: "active",
                },
                { onConflict: "thread_id,funnel_id" },
              );
              await advanceFreshPlacement(supabase, thread.threadId, node.funnel_id as string);
            }
          }
        }
      }

      if (buttonId) {
        await advanceButton(thread.threadId, buttonId);
        continue;
      }

      const aiHandled = text ? await triggerAiIfActive(supabase, orgId, thread.threadId, text, inboundMessage?.id ?? null) : false;
      if (aiHandled) continue;

      if (thread.isNewLead) {
        await enrollNewLead(supabase, orgId, thread.threadId, senderId);
      }
    }

    for (const change of entry.changes ?? []) {
      if (change.field === "comments" && change.value?.id) {
        const eventId = `comment:${change.value.id}`;
        if (!(await claimEvent(supabase, orgId, eventId))) continue;
        const token = await accessTokenForSending();
        if (token) await handleCommentEvent(supabase, orgId, token, change.value);
      } else if (change.field === "mentions" && change.value?.media_id) {
        const eventId = `mention:${change.value.media_id}:${change.value.comment_id ?? ""}`;
        if (!(await claimEvent(supabase, orgId, eventId))) continue;
        const token = await accessTokenForSending();
        if (token) await handleMentionEvent(supabase, orgId, token, change.value);
      }
      // 'story_insights' (view/reply counters, not an event to react to) is
      // deliberately not handled here — nothing in ТЗ needs it acted on.
    }
  }

  return jsonResponse200();
};
