import type { Handler } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { dispatchInitialStageConversion } from "./_shared/stage-conversion";
import { logInitialSubscribeEvent, logRepeatSubscribeEvent, patchInitialSubscribeLink } from "./_shared/subscription-log";
import { markBotBlocked } from "./_shared/bot-block";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface TelegramFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    caption?: string;
    chat: { id: number };
    from?: { username?: string; first_name?: string; last_name?: string };
    // Telegram sends photos as an array of sizes, smallest first; everything
    // else is a single object under its own key.
    photo?: (TelegramFile & { width?: number; height?: number })[];
    video?: TelegramFile;
    video_note?: TelegramFile;
    animation?: TelegramFile;
    audio?: TelegramFile;
    voice?: TelegramFile;
    document?: TelegramFile;
    sticker?: TelegramFile;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id?: number };
  };
  // Chat-membership transitions for the bot itself — sent whenever a user
  // blocks/unblocks it (status "kicked"/"member"). allowed_updates is never
  // restricted at setWebhook, so this arrives without any extra registration.
  my_chat_member?: {
    chat: { id: number };
    new_chat_member: { status: string };
  };
}

// Graph-model add-on (isolated from the linear funnels/funnel_states flow
// below): extracts the lead_gen_links.ref_token payload from a Telegram
// /start deep-link, e.g. "/start ab3dK9pq" -> "ab3dK9pq".
function parseStartPayload(text: string): string | null {
  const match = text.match(/^\/start(?:@\w+)?\s+(\S+)/);
  return match ? match[1] : null;
}

// Nested-select shape for the single combined lookup below — see
// LeadGenLinkRow further down for the same cast-a-nested-select convention.
interface CallbackFunnelStateRow {
  id: string;
  funnel_id: string;
  funnel_node_id: string | null;
  status: string;
  created_at: string;
}
interface CallbackThreadRow {
  id: string;
  channel_type: string;
  funnel_states: CallbackFunnelStateRow[] | null;
}
interface CallbackLeadRow {
  id: string;
  threads: CallbackThreadRow[] | null;
}

// Handles a callback_query (inline keyboard button tap). Fully separate from
// the message/enrollment flow below — resolves and advances the lead's graph
// funnel_states immediately via funnel-processor-v2, instead of waiting for cron.
//
// Performance-critical path: Telegram measured ~2.6s of sequential Supabase/
// fetch round trips here before funnel-advance-background was ever called,
// long enough to risk Telegram retrying the same callback_query mid-flight.
// Two changes fix that — neither changes behavior, only how the same work is
// scheduled: (1) vault_read_secret and the lead/thread/state lookup don't
// depend on each other, so they run concurrently instead of one after the
// other; (2) leads -> threads -> funnel_states used to be three sequential
// round trips (each only ever needed the id of the row before it) — now one
// nested select, filtered/sorted in JS instead of in the query itself so the
// embed doesn't need PostgREST's nested-nested filter syntax.
async function handleCallbackQuery(
  supabase: SupabaseClient,
  callbackQuery: NonNullable<TelegramUpdate["callback_query"]>,
  credential: { bot_token_secret_id: string },
  orgId: string,
) {
  const chatId = callbackQuery.message?.chat.id;
  const chosenButtonId = callbackQuery.data;
  if (chatId === undefined || !chosenButtonId) {
    return { statusCode: 200, body: "OK" };
  }

  const [{ data: botToken }, { data: leadRow, error: lookupError }] = await Promise.all([
    supabase.rpc("vault_read_secret", { secret_id: credential.bot_token_secret_id }),
    supabase
      .from("leads")
      // No spaces inside the nested parens here — confirmed live against
      // PostgREST that a double-nested embed with spaces 400s
      // (PGRST100, "unexpected )") even though a single level tolerates them.
      .select("id,threads(id,channel_type,funnel_states(id,funnel_id,funnel_node_id,status,created_at))")
      .eq("org_id", orgId)
      .eq("channel_type", "telegram")
      .eq("external_id", String(chatId))
      .maybeSingle(),
  ]);

  // Fired, not awaited: only stops Telegram's loading spinner on the button,
  // nothing below depends on it. Awaited once in the finally block instead —
  // still guaranteed to settle before this function returns through any of
  // the early-return paths below, because Netlify freezes the process the
  // instant a response goes out, and a truly un-awaited fetch could get cut
  // off mid-flight.
  const answerPromise = botToken
    ? fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQuery.id }),
      }).catch((err) => {
        console.error("telegram-webhook: answerCallbackQuery failed", err);
      })
    : Promise.resolve();

  try {
    if (lookupError) {
      console.error("telegram-webhook: lead/thread/state lookup failed", lookupError);
      return { statusCode: 200, body: "OK" };
    }
    if (!leadRow) return { statusCode: 200, body: "OK" };

    const thread = (leadRow as unknown as CallbackLeadRow).threads?.find((t) => t.channel_type === "telegram") ?? null;
    if (!thread) return { statusCode: 200, body: "OK" };

    // A thread can have more than one 'active' graph state now (a lead
    // enrolled in several funnels) — a button click carries no signal about
    // which one it belongs to, so this picks the most recently entered one.
    // Same heuristic and same-shaped event as ai-respond.ts's
    // multiple_ai_active_states, just for graph-active states instead of
    // ai_active.
    const activeStates = (thread.funnel_states ?? [])
      .filter((s) => s.status === "active" && s.funnel_node_id !== null)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const state = activeStates[0] ?? null;
    if (!state) return { statusCode: 200, body: "OK" };

    if (activeStates.length > 1) {
      const { error: eventError } = await supabase.from("events").insert({
        org_id: orgId,
        type: "multiple_active_funnel_states",
        level: "warn",
        payload: {
          thread_id: thread.id,
          resolved_state_id: state.id,
          chosen_button_id: chosenButtonId,
          states: activeStates.map((s) => ({ id: s.id, funnel_id: s.funnel_id, funnel_node_id: s.funnel_node_id })),
        },
      });
      if (eventError) console.error("telegram-webhook: events insert failed", eventError);
    }

    const siteUrl = process.env.URL;
    if (!siteUrl) {
      console.error("telegram-webhook: URL сайту не сконфігуровано, не можу викликати funnel-advance");
      return { statusCode: 200, body: "OK" };
    }

    // funnel-processor-v2.ts is a *scheduled* function — Netlify rejects direct
    // HTTP calls to those (confirmed: 403), so immediate advancement goes
    // through funnel-advance.ts instead, which shares the same processing logic.
    //
    // The -background variant so this returns to Telegram fast: the graph walk
    // triggered here can land on an AI node and run its full opening turn
    // (OpenRouter round trip), which is exactly the multi-second wait that used
    // to risk a Telegram-side retry of this same callback_query.
    try {
      await fetch(`${siteUrl}/.netlify/functions/funnel-advance-background`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stateId: state.id, chosenButtonId, callbackMessageId: callbackQuery.message?.message_id ?? null }),
      });
    } catch (err) {
      console.error("telegram-webhook: funnel-advance invoke failed", err);
    }

    return { statusCode: 200, body: "OK" };
  } finally {
    await answerPromise;
  }
}

// Inbound media, mapped onto the same attachment types the message builder
// and the chat renderer already use.
const INBOUND_MEDIA: { key: keyof NonNullable<TelegramUpdate["message"]>; type: string }[] = [
  { key: "photo", type: "photo" },
  { key: "video", type: "video" },
  { key: "video_note", type: "video_note" },
  { key: "animation", type: "animation" },
  { key: "audio", type: "audio" },
  { key: "voice", type: "voice" },
  { key: "document", type: "document" },
  { key: "sticker", type: "photo" },
];

const ATTACHMENT_BUCKET = "message-attachments";
// The bucket's own ceiling. A larger file is recorded as a placeholder rather
// than half-downloaded.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

interface InboundAttachment {
  type: string;
  url: string;
  filename?: string;
}

/**
 * Copies one inbound Telegram file into our own storage and returns a public
 * URL for it.
 *
 * Telegram's own file URL embeds the bot token
 * (api.telegram.org/file/bot<TOKEN>/...), so it can never be stored on the
 * message or handed to a browser — that would leak the org's bot credential
 * to everyone who can open the thread. Re-hosting also outlives Telegram's
 * short-lived file paths.
 */
async function storeTelegramFile(
  supabase: SupabaseClient,
  botToken: string,
  orgId: string,
  file: TelegramFile,
  type: string,
): Promise<InboundAttachment | null> {
  if (file.file_size && file.file_size > MAX_ATTACHMENT_BYTES) {
    console.error("telegram-webhook: attachment too large, skipping download", file.file_size);
    return null;
  }

  try {
    const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(file.file_id)}`);
    const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string } };
    const filePath = info.result?.file_path;
    if (!infoRes.ok || !info.ok || !filePath) {
      console.error("telegram-webhook: getFile failed", info);
      return null;
    }

    const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
    if (!fileRes.ok) {
      console.error("telegram-webhook: file download failed", fileRes.status);
      return null;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      console.error("telegram-webhook: downloaded file over limit", buffer.byteLength);
      return null;
    }

    const baseName = file.file_name ?? filePath.split("/").pop() ?? "file";
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    // Same <org>/<uuid>-<name> layout upload-attachment.ts uses, so inbound
    // and outbound media sit together and stay org-scoped.
    const path = `${orgId}/${randomUUID()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, buffer, { contentType: file.mime_type ?? "application/octet-stream", upsert: false });

    if (uploadError) {
      console.error("telegram-webhook: attachment upload failed", uploadError);
      return null;
    }

    const { data } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);
    return { type, url: data.publicUrl, filename: file.file_name ?? safeName };
  } catch (err) {
    console.error("telegram-webhook: attachment handling threw", err);
    return null;
  }
}

/** Picks the media on an update, if any. Photos come as sizes — take the largest. */
function pickInboundMedia(message: NonNullable<TelegramUpdate["message"]>): { file: TelegramFile; type: string } | null {
  for (const { key, type } of INBOUND_MEDIA) {
    const value = message[key];
    if (!value) continue;
    if (Array.isArray(value)) {
      const largest = value[value.length - 1];
      if (largest) return { file: largest, type };
      continue;
    }
    return { file: value as TelegramFile, type };
  }
  return null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // setWebhook registers /.netlify/functions/telegram-webhook/<org_id> — the
  // trailing path segment tells us which org this update belongs to.
  const orgId = event.path.split("/telegram-webhook/")[1] ?? null;
  if (!orgId) {
    console.error("telegram-webhook: missing org_id in path", event.path);
    return { statusCode: 200, body: "OK" };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The credential row doubles as verification: an org_id in the URL with no
  // active telegram integration means this isn't a request we should act on.
  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id, webhook_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .maybeSingle();

  if (credentialError || !credential) {
    console.error("telegram-webhook: no active telegram credential for org", orgId);
    return { statusCode: 200, body: "OK" };
  }

  // Before touching anything else: confirm this request actually came from
  // Telegram. Reject with a plain 200 (not 401/403) so a prober can't tell
  // this endpoint exists from the response — just log it server-side.
  const providedSecret = event.headers["x-telegram-bot-api-secret-token"] ?? event.headers["X-Telegram-Bot-Api-Secret-Token"];
  const { data: expectedSecret } = credential.webhook_secret_id
    ? await supabase.rpc("vault_read_secret", { secret_id: credential.webhook_secret_id })
    : { data: null };

  if (!expectedSecret || providedSecret !== expectedSecret) {
    console.error("telegram-webhook: secret_token mismatch, rejecting silently", { orgId });
    return { statusCode: 200, body: "OK" };
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 200, body: "OK" };
  }

  // Idempotency: Telegram retries webhook delivery of the SAME update if our
  // response is too slow (this function has been measured taking 10-30s on
  // an AI hand-off turn), and re-delivery carries the identical update_id.
  // The insert's unique constraint on (org_id, update_id) is the atomic gate
  // — claim it first, then process; a 23505 means someone (this update's
  // earlier delivery, or a concurrent one landing at the same instant)
  // already claimed it, so this call does nothing further. update_id is only
  // unique per bot, never globally, hence the org_id half of the key.
  if (typeof update.update_id === "number") {
    const { error: dedupError } = await supabase
      .from("processed_telegram_updates")
      .insert({ org_id: orgId, update_id: update.update_id });

    if (dedupError) {
      if (dedupError.code === "23505") {
        console.error("telegram-webhook: duplicate update_id, skipping", { orgId, updateId: update.update_id });
        return { statusCode: 200, body: "OK" };
      }
      // Any other error is a dedup-bookkeeping failure, not evidence of a
      // duplicate — better to risk an occasional double-send than to drop a
      // lead's message because this table had a hiccup.
      console.error("telegram-webhook: dedup insert failed, processing anyway", dedupError);
    }
  }

  // Passive bot-block signal: fully separate from message/callback_query
  // below. chat.id is used to resolve the lead (not from.id) to match every
  // other lookup in this file — for a private chat with the bot, Telegram's
  // chat.id here is the same value already stored as leads.external_id.
  if (update.my_chat_member) {
    const chatId = update.my_chat_member.chat?.id;
    const newStatus = update.my_chat_member.new_chat_member?.status;
    if (chatId !== undefined && (newStatus === "kicked" || newStatus === "member")) {
      const { data: lead, error: leadLookupError } = await supabase
        .from("leads")
        .select("id")
        .eq("org_id", orgId)
        .eq("channel_type", "telegram")
        .eq("external_id", String(chatId))
        .maybeSingle();
      if (leadLookupError) console.error("telegram-webhook: my_chat_member lead lookup failed", leadLookupError);
      if (lead) await markBotBlocked(supabase, orgId, lead.id, newStatus === "kicked");
    }
    return { statusCode: 200, body: "OK" };
  }

  // Graph-model add-on: inline keyboard button taps arrive as callback_query,
  // never as message — fully separate path, doesn't touch anything below.
  if (update.callback_query) {
    return handleCallbackQuery(supabase, update.callback_query, credential, orgId);
  }

  const message = update.message;
  if (!message || message.chat?.id === undefined) {
    return { statusCode: 200, body: "OK" };
  }

  const media = pickInboundMedia(message);
  // A caption is the text of a media message; without either, there's nothing
  // to record (edited messages, reactions, and so on).
  const messageText = message.text ?? message.caption ?? "";
  if (!messageText && !media) {
    return { statusCode: 200, body: "OK" };
  }

  const { data: botToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });

  if (tokenError || !botToken) {
    console.error("telegram-webhook: failed to decrypt bot token", tokenError);
    return { statusCode: 200, body: "OK" };
  }

  const chatId = String(message.chat.id);
  const username = message.from?.username ?? null;
  const firstName = message.from?.first_name ?? null;
  const lastName = message.from?.last_name ?? null;

  // Checked before the upsert below so we can tell a brand-new lead apart
  // from a returning one (needed for funnel enrollment further down).
  const { data: existingLead } = await supabase
    .from("leads")
    .select("id")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .eq("external_id", chatId)
    .maybeSingle();
  const isNewLead = !existingLead;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .upsert(
      { org_id: orgId, channel_type: "telegram", external_id: chatId, username, first_name: firstName, last_name: lastName },
      { onConflict: "org_id,channel_type,external_id" },
    )
    .select("id, status")
    .single();

  if (leadError || !lead) {
    console.error("telegram-webhook: failed to upsert lead", leadError);
    return { statusCode: 200, body: "OK" };
  }

  // leads.subscribed defaults to true — this is the event that makes that
  // default visible in "Підписки за джерелом" instead of it silently never
  // happening. link_id starts null and gets patched below once/if
  // source_link_id attribution resolves later in this same request.
  const initialSubscribeEventId = await logInitialSubscribeEvent(supabase, orgId, lead.id, isNewLead);

  // No automated reply of any kind reaches a blocked or archived lead — the
  // message itself is still recorded below either way, so the thread stays
  // fully readable. Checked once here rather than separately in each of the
  // three send paths further down (LGT-driven funnel, AI hand-off, canned
  // reply) so there's a single, obvious place this decision is made.
  const isSuppressed = lead.status === "blocked" || lead.status === "archived";

  const { data: thread, error: threadError } = await supabase
    .from("threads")
    .upsert(
      { org_id: orgId, lead_id: lead.id, channel_type: "telegram" },
      { onConflict: "lead_id,channel_type" },
    )
    .select("id")
    .single();

  if (threadError || !thread) {
    console.error("telegram-webhook: failed to upsert thread", threadError);
    return { statusCode: 200, body: "OK" };
  }

  // New activity always reopens a closed thread — a lead's own message
  // shouldn't sit invisible behind the "Показати закриті" toggle. Applies
  // regardless of isSuppressed: this only affects where the thread shows up
  // in Chats, not whether anything gets sent to the lead.
  const { error: reopenError } = await supabase
    .from("threads")
    .update({ status: "open" })
    .eq("id", thread.id)
    .eq("status", "closed");
  if (reopenError) console.error("telegram-webhook: thread reopen failed", reopenError);

  // Re-hosted before the insert so the row is written once, already carrying
  // its attachment. A failed download degrades to a text-only record rather
  // than losing the message.
  const attachment = media ? await storeTelegramFile(supabase, botToken as string, orgId, media.file, media.type) : null;

  // Id kept so a recognised /start can be re-labelled with link metadata
  // below, once we know which lead-gen link the token belongs to.
  const { data: inboundMessage } = await supabase
    .from("messages")
    .insert({
      org_id: orgId,
      thread_id: thread.id,
      direction: "inbound",
      body: messageText,
      meta: attachment ? { attachments: [attachment] } : null,
    })
    .select("id")
    .single();

  const { error: unreadError } = await supabase.rpc("increment_thread_unread", { p_thread_id: thread.id });
  if (unreadError) console.error("telegram-webhook: increment_thread_unread failed", unreadError);

  // Every genuinely new inbound message gets a push, regardless of which
  // branch (start payload / AI hand-off / canned reply / silence) handles it
  // below — a manager should be notified even when nothing gets auto-sent
  // back. -background so a slow push service never delays this webhook's own
  // response to Telegram.
  {
    const siteUrl = process.env.URL;
    if (siteUrl) {
      try {
        await fetch(`${siteUrl}/.netlify/functions/send-push-notification-background`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
          body: JSON.stringify({
            orgId,
            threadId: thread.id,
            title: username ? `@${username}` : "Новий лід",
            body: messageText || (media ? "Надіслав(ла) файл" : ""),
          }),
        });
      } catch (err) {
        console.error("telegram-webhook: send-push-notification invoke failed", err);
      }
    }
  }

  // Voice notes get a transcript so a manager can read the thread without
  // playing every clip.
  //
  // Awaited rather than fired and forgotten: a Netlify function is frozen as
  // soon as it responds, so a floating promise here would be cancelled mid-
  // flight often enough to make transcripts unreliable. A short clip costs a
  // couple of seconds, well inside Telegram's webhook timeout, and the
  // transcriber itself never throws — a failure lands in `events` and the
  // message is already saved and playable regardless.
  if (attachment && (attachment.type === "voice" || attachment.type === "audio") && inboundMessage) {
    const siteUrl = process.env.URL;
    if (siteUrl) {
      try {
        await fetch(`${siteUrl}/.netlify/functions/transcribe-voice`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
          body: JSON.stringify({ messageId: inboundMessage.id }),
        });
      } catch (err) {
        console.error("telegram-webhook: transcribe-voice invoke failed", err);
      }
    }
  }

  // A /start carrying a known click_id (or, as a fallback, a bare ref_token)
  // is an explicit "run this funnel" instruction, so it's resolved before
  // anything else — ahead of the AI hand-off and ahead of the canned reply.
  // It used to sit behind an isNewLead gate, which meant a returning lead's
  // link click was silently ignored and fell through to the canned reply.
  const startPayload = messageText ? parseStartPayload(messageText) : null;
  if (startPayload) {
    type LeadGenLinkRow = {
      id: string;
      name: string;
      funnel_id: string;
      entry_node_id: string | null;
      pixel_id: string | null;
      funnels: { name: string } | null;
    };

    let leadGenLink: LeadGenLinkRow | null = null;
    // Set only when startPayload resolved through link_clicks — carries the
    // fbclid/IP/UA meta-capi-send.ts needs to build Meta's fbc parameter.
    // The ref_token fallback below has no click row, so this stays null.
    let matchedClickId: string | null = null;

    // Preferred path: startPayload is a click_id minted by redirect.ts for
    // this one visit.
    const { data: clickRow, error: clickLookupError } = await supabase
      .from("link_clicks")
      .select("lead_gen_links ( id, name, funnel_id, entry_node_id, pixel_id, funnels ( name ) )")
      .eq("click_id", startPayload)
      .eq("org_id", orgId)
      .maybeSingle();

    if (clickLookupError) console.error("telegram-webhook: link_clicks lookup failed", clickLookupError);

    if (clickRow?.lead_gen_links) {
      leadGenLink = clickRow.lead_gen_links as unknown as LeadGenLinkRow;
      matchedClickId = startPayload;
    } else {
      // Fallback: an old-style link copied before click_id existed, or one
      // that bypassed redirect.ts entirely — matches ref_token directly, same
      // as before this change. No click row means no fbclid/IP/UA for CAPI.
      const { data: directLink, error: directLinkError } = await supabase
        .from("lead_gen_links")
        .select("id, name, funnel_id, entry_node_id, pixel_id, funnels ( name )")
        .eq("org_id", orgId)
        .eq("ref_token", startPayload)
        .maybeSingle();

      if (directLinkError) console.error("telegram-webhook: lead_gen_links lookup failed", directLinkError);
      leadGenLink = directLink as LeadGenLinkRow | null;
    }

    if (leadGenLink) {
      // First-touch attribution: only set once, so a returning lead's later
      // click through the same or a different link never overwrites the
      // original source shown on their profile.
      const { data: attributed, error: sourceLinkError } = await supabase
        .from("leads")
        .update({ source_link_id: leadGenLink.id, source_click_id: matchedClickId })
        .eq("id", lead.id)
        .is("source_link_id", null)
        .select("id");
      if (sourceLinkError) console.error("telegram-webhook: source_link_id update failed", sourceLinkError);

      // The leads insert trigger already wrote the «Підписка» stage entry,
      // but at that moment the lead had no source link yet — so the send is
      // dispatched here, the first point where attribution exists. Only on
      // the update that actually set it, so a returning lead's later click
      // doesn't re-fire a conversion for a subscription they already had.
      if (attributed && attributed.length > 0) {
        await dispatchInitialStageConversion(supabase, orgId, lead.id);
      }

      // Independent of the attribution check above: source_link_id is
      // first-touch-only, but every resolved link click is still its own
      // subscribe event for "Підписки за джерелом". A fresh event from
      // logInitialSubscribeEvent above gets its link_id filled in; anyone
      // else (almost always a returning lead) gets a brand new event for
      // this click.
      if (initialSubscribeEventId) {
        await patchInitialSubscribeLink(supabase, initialSubscribeEventId, leadGenLink.id);
      } else {
        await logRepeatSubscribeEvent(supabase, orgId, lead.id, leadGenLink.id);
      }

      // Label the raw "/start <token>" so the chat can render it as a system
      // block ("came in via <link> → <funnel>") instead of gibberish text.
      if (inboundMessage) {
        const funnelName = leadGenLink.funnels?.name ?? null;
        const { error: metaError } = await supabase
          .from("messages")
          .update({ meta: { type: "lgt_start", link_name: leadGenLink.name, funnel_name: funnelName } })
          .eq("id", inboundMessage.id);
        if (metaError) console.error("telegram-webhook: message meta update failed", metaError);
      }

      // The link's own configured entry point — not "whichever entry node
      // the funnel happens to have" (a funnel can have several now, one per
      // link; see FunnelBuilder.tsx). Null means the node it pointed to was
      // since deleted (ON DELETE SET NULL) — nothing to enroll into, so this
      // falls through to the AI/canned-reply path below like a funnel with
      // no matching link at all.
      if (leadGenLink.entry_node_id) {
        // Restart semantics: a link click always begins the funnel again, so
        // an existing row for this (thread, funnel) is reset to the entry
        // node rather than left mid-flow. ai_progress is cleared with it —
        // unless the entry node's own config opts out and the lead is
        // currently mid-conversation with an AI node (see below).
        const { data: entryNode, error: entryNodeError } = await supabase
          .from("funnel_nodes")
          .select("config")
          .eq("id", leadGenLink.entry_node_id)
          .maybeSingle();
        if (entryNodeError) console.error("telegram-webhook: entry node config lookup failed", entryNodeError);

        const restartOnReentry = (entryNode?.config as { restart_on_reentry?: boolean } | null)?.restart_on_reentry !== false;

        if (!restartOnReentry) {
          const { data: existingState, error: existingStateError } = await supabase
            .from("funnel_states")
            .select("status")
            .eq("thread_id", thread.id)
            .eq("funnel_id", leadGenLink.funnel_id)
            .maybeSingle();
          if (existingStateError) console.error("telegram-webhook: existing funnel_states lookup failed", existingStateError);

          // The toggle protects a live AI exchange specifically — any other
          // status (active on a non-AI node, completed, stopped) still
          // restarts exactly as before. No funnel_states write, no
          // ai_progress touch: the lead's state is left exactly as it is.
          if (existingState?.status === "ai_active") {
            return { statusCode: 200, body: "OK" };
          }
        }

        const { data: state, error: stateError } = await supabase
          .from("funnel_states")
          .upsert(
            {
              thread_id: thread.id,
              org_id: orgId,
              funnel_id: leadGenLink.funnel_id,
              funnel_node_id: leadGenLink.entry_node_id,
              status: "active",
              current_step: 0,
              waiting_until: new Date().toISOString(),
              ai_progress: null,
            },
            { onConflict: "thread_id,funnel_id" },
          )
          .select("id")
          .single();

        if (stateError) console.error("telegram-webhook: funnel_states upsert failed", stateError);

        // Advance immediately rather than waiting up to a minute for cron —
        // an ad click should get its first message right away.
        const siteUrl = process.env.URL;
        if (state && siteUrl) {
          try {
            // -background so this returns fast — see the callback_query path
            // above for why (the walk can reach an AI node's opening turn).
            await fetch(`${siteUrl}/.netlify/functions/funnel-advance-background`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              // enrollment is a thin marker only — funnel-graph.ts looks up
              // the pixel_id / click row itself (see maybeSendMetaConversion),
              // so telegram-webhook.ts stays ignorant of Meta CAPI specifics.
              body: JSON.stringify({
                stateId: state.id,
                enrollment: { linkId: leadGenLink.id, clickId: matchedClickId },
                // Just enrolled onto the link's entry node — which may be a
                // delay (lead_gen_links.entry_node_id can be any node).
                freshPlacement: true,
              }),
            });
          } catch (err) {
            // Already active and due, so the cron picks it up regardless.
            console.error("telegram-webhook: funnel-advance invoke failed", err);
          }
        }

        // No canned reply: the funnel itself is the response.
        return { statusCode: 200, body: "OK" };
      }
    }
  }

  // Isolated add-on: once the graph has parked this thread on an ai node, the
  // model answers instead of the canned reply below. The inbound message is
  // still recorded above either way — messages stays the full transcript.
  //
  // A thread can have more than one 'ai_active' row now (a lead enrolled in
  // several funnels) — free text carries no signal about which conversation
  // it continues, so this picks the most recently entered one. ai-respond.ts
  // logs a multiple_ai_active_states event whenever that ambiguity actually
  // exists, so it stays visible in /admin/security rather than silently
  // guessed away.
  const { data: aiStates, error: aiStateError } = await supabase
    .from("funnel_states")
    .select("id")
    .eq("thread_id", thread.id)
    .eq("status", "ai_active")
    .order("created_at", { ascending: false });

  if (aiStateError) console.error("telegram-webhook: ai_active lookup failed", aiStateError);
  const aiState = aiStates?.[0] ?? null;

  // Covers both remaining send paths below (AI hand-off and the canned
  // reply) in one place — the message is already recorded above, so the
  // thread stays fully readable, only the automated reply is withheld.
  if (isSuppressed) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "blocked_lead_ignored",
      level: "info",
      payload: { source: "telegram-webhook", thread_id: thread.id, lead_id: lead.id, lead_status: lead.status },
    });
    if (eventError) console.error("telegram-webhook: events insert failed", eventError);
    return { statusCode: 200, body: "OK" };
  }

  if (aiState) {
    const siteUrl = process.env.URL;
    if (!siteUrl) {
      console.error("telegram-webhook: URL сайту не сконфігуровано, не можу викликати ai-respond");
      return { statusCode: 200, body: "OK" };
    }

    // -background so this responds to Telegram in milliseconds instead of
    // waiting out the full OpenRouter round trip (measured 7-30s depending on
    // reply length) — that wait is exactly what risks Telegram retrying this
    // same update (see the idempotency guard above for what happens then).
    try {
      await fetch(`${siteUrl}/.netlify/functions/ai-respond-background`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
        body: JSON.stringify({ threadId: thread.id, stateId: aiState.id, userText: messageText, inboundMessageId: inboundMessage?.id }),
      });
    } catch (err) {
      console.error("telegram-webhook: ai-respond invoke failed", err);
    }

    return { statusCode: 200, body: "OK" };
  }

  // Silence is the default. A lead writing free text while the funnel is
  // parked — on a delay, on a message node with or without buttons, anywhere
  // — gets no automated answer at all: the message is recorded above and the
  // thread stays fully readable, but nothing is sent back. Only two things
  // ever reply automatically: the AI hand-off (handled above) and the
  // funnel's own message nodes, which the graph walk sends.
  //
  // There used to be a blanket "Дякуємо, ми отримали ваше повідомлення" here.
  // It fired on every free-text message that wasn't /start and wasn't
  // ai_active, which meant a lead mid-conversation got it repeatedly — it
  // answered nothing, contradicted the funnel's own wording, and in a foreign
  // language at that.

  // Isolated add-on: enroll brand-new leads into an active funnel, if the org
  // has one. Existing leads are never touched by this.
  //
  // This is the one place left that still picks "the" active funnel rather
  // than a specific one via lead_gen_links.entry_node_id — there's no link at
  // all here (organic /start with no payload, or a bare message), so nothing
  // else identifies which funnel a truly organic lead should enter. Multiple
  // funnels can be active at once now (see toggle-funnel.ts), so this needs a
  // stable tie-break: oldest active funnel wins, keeping today's behavior
  // unchanged for the common case of exactly one active funnel.
  if (isNewLead) {
    const { data: funnel, error: funnelError } = await supabase
      .from("funnels")
      .select("id")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (funnelError) {
      console.error("telegram-webhook: funnels lookup failed", funnelError);
    } else if (funnel) {
      const { error: funnelStateError } = await supabase.from("funnel_states").insert({
        thread_id: thread.id,
        org_id: orgId,
        funnel_id: funnel.id,
        current_step: 0,
        waiting_until: new Date().toISOString(),
        status: "active",
      });
      if (funnelStateError) console.error("telegram-webhook: funnel_states insert failed", funnelStateError);
    }

  }

  return { statusCode: 200, body: "OK" };
};
