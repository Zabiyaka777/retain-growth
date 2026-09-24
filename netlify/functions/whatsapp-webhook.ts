import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { dispatchInitialStageConversion } from "./_shared/stage-conversion";
import { logInitialSubscribeEvent, logRepeatSubscribeEvent, patchInitialSubscribeLink } from "./_shared/subscription-log";
import { verifyWebhookSignature } from "./_shared/whatsapp";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// WhatsApp Cloud API delivers everything wrapped in entry[].changes[].value.
// Interactive replies (button/list taps) are the WhatsApp counterpart of
// Telegram's callback_query and arrive as a normal message with type
// "interactive", not as a separate update kind.
interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}

interface WhatsAppContact {
  wa_id: string;
  profile?: { name?: string };
}

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: WhatsAppContact[];
        messages?: WhatsAppMessage[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

/**
 * The text a lead actually sent, whichever envelope it came in.
 * `buttonId` is set only for an interactive reply — it carries the funnel
 * button id, the same value Telegram sends as callback_query.data.
 */
function extractContent(message: WhatsAppMessage): { text: string | null; buttonId: string | null } {
  if (message.type === "text") return { text: message.text?.body ?? null, buttonId: null };

  if (message.type === "interactive") {
    const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
    return { text: reply?.title ?? null, buttonId: reply?.id ?? null };
  }

  // Template quick-reply buttons come back in this older shape, where the
  // payload is what was configured on the template.
  if (message.type === "button") {
    return { text: message.button?.text ?? null, buttonId: message.button?.payload ?? null };
  }

  return { text: null, buttonId: null };
}

// A WhatsApp deep link (wa.me/<number>?text=...) can carry a prefilled body,
// which is how a lead-gen link's token reaches us — the WhatsApp counterpart
// of Telegram's "/start <payload>". Both the Telegram-style form and a bare
// token-only message are accepted, since the operator controls the prefill
// text and may or may not include the verb.
function parseStartPayload(text: string): string | null {
  const explicit = text.match(/^\/start\s+(\S+)/i);
  if (explicit) return explicit[1];
  const bare = text.trim().match(/^([A-Za-z0-9_-]{6,64})$/);
  return bare ? bare[1] : null;
}

/**
 * Resolves and advances the lead's graph funnel state after a button tap.
 * Mirrors telegram-webhook.ts's handleCallbackQuery, minus the acknowledge
 * call — WhatsApp has no spinner to clear.
 */
async function handleButtonReply(
  supabase: SupabaseClient,
  orgId: string,
  threadId: string,
  chosenButtonId: string,
): Promise<void> {
  const { data: state } = await supabase
    .from("funnel_states")
    .select("id")
    .eq("thread_id", threadId)
    .eq("status", "active")
    .not("funnel_node_id", "is", null)
    .maybeSingle();

  if (!state) return;

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    console.error("whatsapp-webhook: URL сайту не сконфігуровано, не можу викликати funnel-advance");
    return;
  }

  try {
    await fetch(`${siteUrl}/.netlify/functions/funnel-advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stateId: state.id, chosenButtonId }),
    });
  } catch (err) {
    console.error("whatsapp-webhook: funnel-advance invoke failed", err);
  }
}

export const handler: Handler = async (event) => {
  // Same org-id-in-path shape as telegram-webhook.ts — the app's webhook is
  // configured per org as /whatsapp-webhook/<org_id>.
  const orgId = event.path.split("/whatsapp-webhook/")[1] ?? null;
  if (!orgId) {
    console.error("whatsapp-webhook: missing org_id in path", event.path);
    return { statusCode: 200, body: "OK" };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The credential row doubles as verification: an org_id in the URL with no
  // active whatsapp integration isn't a request we should act on.
  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("webhook_secret_id, app_secret_secret_id, phone_number_id")
    .eq("org_id", orgId)
    .eq("channel_type", "whatsapp")
    .maybeSingle();

  if (credentialError || !credential) {
    console.error("whatsapp-webhook: no active whatsapp credential for org", orgId);
    return { statusCode: 200, body: "OK" };
  }

  const { data: expectedSecret } = credential.webhook_secret_id
    ? await supabase.rpc("vault_read_secret", { secret_id: credential.webhook_secret_id })
    : { data: null };

  // Meta verifies a webhook URL once with a GET carrying hub.challenge, which
  // must be echoed back verbatim. This is the only GET this endpoint answers.
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters ?? {};
    if (params["hub.mode"] === "subscribe" && expectedSecret && params["hub.verify_token"] === expectedSecret) {
      return { statusCode: 200, body: params["hub.challenge"] ?? "" };
    }
    console.error("whatsapp-webhook: verify token mismatch", { orgId });
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Before touching anything else: confirm this POST actually came from Meta.
  // Rejected with a plain 200 (not 401/403) so a prober can't tell from the
  // response that this endpoint exists — same posture as telegram-webhook.ts.
  const { data: appSecret } = credential.app_secret_secret_id
    ? await supabase.rpc("vault_read_secret", { secret_id: credential.app_secret_secret_id })
    : { data: null };

  if (!appSecret) {
    console.error("whatsapp-webhook: no app secret stored, cannot verify signature", { orgId });
    return { statusCode: 200, body: "OK" };
  }

  const signature = event.headers["x-hub-signature-256"] ?? event.headers["X-Hub-Signature-256"];
  if (!verifyWebhookSignature(event.body ?? "", signature, appSecret as string)) {
    console.error("whatsapp-webhook: signature mismatch, rejecting silently", { orgId });
    return { statusCode: 200, body: "OK" };
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 200, body: "OK" };
  }

  const change = payload.entry?.[0]?.changes?.[0]?.value;
  const message = change?.messages?.[0];

  // Delivery/read receipts arrive on the same webhook as `statuses` with no
  // `messages` — acknowledged and ignored, or Meta keeps retrying them.
  if (!message) return { statusCode: 200, body: "OK" };

  const { text, buttonId } = extractContent(message);
  if (!text && !buttonId) {
    // Media, location, reactions — nothing to record as a text message yet.
    return { statusCode: 200, body: "OK" };
  }

  const waId = message.from;
  const contactName = change?.contacts?.find((c) => c.wa_id === waId)?.profile?.name ?? null;

  const { data: existingLead } = await supabase
    .from("leads")
    .select("id")
    .eq("org_id", orgId)
    .eq("channel_type", "whatsapp")
    .eq("external_id", waId)
    .maybeSingle();
  const isNewLead = !existingLead;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .upsert(
      { org_id: orgId, channel_type: "whatsapp", external_id: waId, username: contactName },
      { onConflict: "org_id,channel_type,external_id" },
    )
    .select("id, status")
    .single();

  if (leadError || !lead) {
    console.error("whatsapp-webhook: failed to upsert lead", leadError);
    return { statusCode: 200, body: "OK" };
  }

  // leads.subscribed defaults to true — see telegram-webhook.ts for why this
  // call exists. link_id starts null and gets patched below if/when
  // source_link_id attribution resolves later in this same request.
  const initialSubscribeEventId = await logInitialSubscribeEvent(supabase, orgId, lead.id, isNewLead);

  const isSuppressed = lead.status === "blocked" || lead.status === "archived";

  const { data: thread, error: threadError } = await supabase
    .from("threads")
    .upsert({ org_id: orgId, lead_id: lead.id, channel_type: "whatsapp" }, { onConflict: "lead_id,channel_type" })
    .select("id")
    .single();

  if (threadError || !thread) {
    console.error("whatsapp-webhook: failed to upsert thread", threadError);
    return { statusCode: 200, body: "OK" };
  }

  // New activity always reopens a closed thread, same rule as Telegram.
  const { error: reopenError } = await supabase
    .from("threads")
    .update({ status: "open" })
    .eq("id", thread.id)
    .eq("status", "closed");
  if (reopenError) console.error("whatsapp-webhook: thread reopen failed", reopenError);

  const { data: inboundMessage } = await supabase
    .from("messages")
    .insert({
      org_id: orgId,
      thread_id: thread.id,
      direction: "inbound",
      body: text ?? "",
    })
    .select("id")
    .single();

  const { error: unreadError } = await supabase.rpc("increment_thread_unread", { p_thread_id: thread.id });
  if (unreadError) console.error("whatsapp-webhook: increment_thread_unread failed", unreadError);

  // Every genuinely new inbound message gets a push, same rule as
  // telegram-webhook.ts — fired here before the button/start/AI branches so
  // it covers all of them, -background so it never delays this webhook's own
  // response to Meta.
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
            title: contactName || "Новий лід",
            body: text || "Надіслав(ла) файл",
          }),
        });
      } catch (err) {
        console.error("whatsapp-webhook: send-push-notification invoke failed", err);
      }
    }
  }

  // A button tap resolves the parked funnel node and nothing else — it isn't
  // a lead-gen entry point and shouldn't fall through to the AI/canned paths.
  if (buttonId) {
    if (inboundMessage) {
      const { error: metaError } = await supabase
        .from("messages")
        .update({ meta: { type: "button_click", label: text } })
        .eq("id", inboundMessage.id);
      if (metaError) console.error("whatsapp-webhook: message meta update failed", metaError);
    }
    if (!isSuppressed) await handleButtonReply(supabase, orgId, thread.id, buttonId);
    return { statusCode: 200, body: "OK" };
  }

  // Lead-gen enrollment, identical in shape to telegram-webhook.ts: a known
  // click_id first, bare ref_token as the fallback.
  const startPayload = text ? parseStartPayload(text) : null;
  if (startPayload && !isSuppressed) {
    type LeadGenLinkRow = {
      id: string;
      name: string;
      funnel_id: string;
      entry_node_id: string | null;
      pixel_id: string | null;
      funnels: { name: string } | null;
    };

    let leadGenLink: LeadGenLinkRow | null = null;
    let matchedClickId: string | null = null;

    const { data: clickRow, error: clickLookupError } = await supabase
      .from("link_clicks")
      .select("lead_gen_links ( id, name, funnel_id, entry_node_id, pixel_id, funnels ( name ) )")
      .eq("click_id", startPayload)
      .eq("org_id", orgId)
      .maybeSingle();

    if (clickLookupError) console.error("whatsapp-webhook: link_clicks lookup failed", clickLookupError);

    if (clickRow?.lead_gen_links) {
      leadGenLink = clickRow.lead_gen_links as unknown as LeadGenLinkRow;
      matchedClickId = startPayload;
    } else {
      const { data: directLink, error: directLinkError } = await supabase
        .from("lead_gen_links")
        .select("id, name, funnel_id, entry_node_id, pixel_id, funnels ( name )")
        .eq("org_id", orgId)
        .eq("ref_token", startPayload)
        .maybeSingle();

      if (directLinkError) console.error("whatsapp-webhook: lead_gen_links lookup failed", directLinkError);
      leadGenLink = directLink as LeadGenLinkRow | null;
    }

    if (leadGenLink) {
      // First-touch attribution, set once — see telegram-webhook.ts.
      const { data: attributed, error: sourceLinkError } = await supabase
        .from("leads")
        .update({ source_link_id: leadGenLink.id, source_click_id: matchedClickId })
        .eq("id", lead.id)
        .is("source_link_id", null)
        .select("id");
      if (sourceLinkError) console.error("whatsapp-webhook: source_link_id update failed", sourceLinkError);

      if (attributed && attributed.length > 0) {
        await dispatchInitialStageConversion(supabase, orgId, lead.id);
      }

      // Independent of the attribution check above — see telegram-webhook.ts.
      if (initialSubscribeEventId) {
        await patchInitialSubscribeLink(supabase, initialSubscribeEventId, leadGenLink.id);
      } else {
        await logRepeatSubscribeEvent(supabase, orgId, lead.id, leadGenLink.id);
      }

      if (inboundMessage) {
        const funnelName = leadGenLink.funnels?.name ?? null;
        const { error: metaError } = await supabase
          .from("messages")
          .update({ meta: { type: "lgt_start", link_name: leadGenLink.name, funnel_name: funnelName } })
          .eq("id", inboundMessage.id);
        if (metaError) console.error("whatsapp-webhook: message meta update failed", metaError);
      }

      if (leadGenLink.entry_node_id) {
        const { data: entryNode, error: entryNodeError } = await supabase
          .from("funnel_nodes")
          .select("config")
          .eq("id", leadGenLink.entry_node_id)
          .maybeSingle();
        if (entryNodeError) console.error("whatsapp-webhook: entry node config lookup failed", entryNodeError);

        const restartOnReentry = (entryNode?.config as { restart_on_reentry?: boolean } | null)?.restart_on_reentry !== false;

        if (!restartOnReentry) {
          const { data: existingState, error: existingStateError } = await supabase
            .from("funnel_states")
            .select("status")
            .eq("thread_id", thread.id)
            .eq("funnel_id", leadGenLink.funnel_id)
            .maybeSingle();
          if (existingStateError) console.error("whatsapp-webhook: existing funnel_states lookup failed", existingStateError);

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

        if (stateError) console.error("whatsapp-webhook: funnel_states upsert failed", stateError);

        const siteUrl = process.env.URL;
        if (state && siteUrl) {
          try {
            await fetch(`${siteUrl}/.netlify/functions/funnel-advance`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                stateId: state.id,
                enrollment: { linkId: leadGenLink.id, clickId: matchedClickId },
              }),
            });
          } catch (err) {
            console.error("whatsapp-webhook: funnel-advance invoke failed", err);
          }
        }

        // No canned reply: the funnel itself is the response.
        return { statusCode: 200, body: "OK" };
      }
    }
  }

  if (isSuppressed) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "blocked_lead_ignored",
      level: "info",
      payload: { source: "whatsapp-webhook", thread_id: thread.id, lead_id: lead.id, lead_status: lead.status },
    });
    if (eventError) console.error("whatsapp-webhook: events insert failed", eventError);
    return { statusCode: 200, body: "OK" };
  }

  // AI hand-off, same parked-state check Telegram makes. A thread can have
  // more than one 'ai_active' row now (a lead enrolled in several funnels) —
  // free text carries no signal about which conversation it continues, so
  // this picks the most recently entered one; ai-respond.ts logs a
  // multiple_ai_active_states event whenever that ambiguity actually exists.
  const { data: aiStates, error: aiStateError } = await supabase
    .from("funnel_states")
    .select("id")
    .eq("thread_id", thread.id)
    .eq("status", "ai_active")
    .order("created_at", { ascending: false });

  if (aiStateError) console.error("whatsapp-webhook: ai_active lookup failed", aiStateError);
  const aiState = aiStates?.[0] ?? null;

  if (aiState && text) {
    const siteUrl = process.env.URL;
    if (!siteUrl) {
      console.error("whatsapp-webhook: URL сайту не сконфігуровано, не можу викликати ai-respond");
      return { statusCode: 200, body: "OK" };
    }

    try {
      await fetch(`${siteUrl}/.netlify/functions/ai-respond`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
        // waMessageId lets ai-respond.ts show the read receipt + typing
        // indicator on exactly this inbound message via Cloud API.
        body: JSON.stringify({ threadId: thread.id, stateId: aiState.id, userText: text, waMessageId: message.id }),
      });
    } catch (err) {
      console.error("whatsapp-webhook: ai-respond invoke failed", err);
    }

    return { statusCode: 200, body: "OK" };
  }

  // Enroll a brand-new lead into the org's active funnel, if it has one —
  // same isolated add-on as Telegram. No canned auto-reply on WhatsApp: an
  // unsolicited "Дякуємо…" would burn a message inside the 24-hour window
  // and reads as spam on this channel.
  //
  // This is the one place left that still picks "the" active funnel rather
  // than a specific one via lead_gen_links.entry_node_id — there's no link at
  // all here, so nothing else identifies which funnel a truly organic lead
  // should enter. Multiple funnels can be active at once now (see
  // toggle-funnel.ts), so this needs a stable tie-break: oldest active funnel
  // wins, keeping today's behavior unchanged for the common case of exactly
  // one active funnel.
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
      console.error("whatsapp-webhook: funnels lookup failed", funnelError);
    } else if (funnel) {
      const { error: funnelStateError } = await supabase.from("funnel_states").insert({
        thread_id: thread.id,
        org_id: orgId,
        funnel_id: funnel.id,
        current_step: 0,
        waiting_until: new Date().toISOString(),
        status: "active",
      });
      if (funnelStateError) console.error("whatsapp-webhook: funnel_states insert failed", funnelStateError);
    }
  }

  return { statusCode: 200, body: "OK" };
};
