// Shared graph-processing logic for funnel-processor-v2.ts (cron, scheduled)
// and funnel-advance.ts (direct call from telegram-webhook.ts after a
// callback_query). Not a handler itself — Netlify only registers files that
// export `handler` as functions, so this file bundles into both callers
// without becoming a third endpoint.
import type { SupabaseClient } from "@supabase/supabase-js";
import { maybeSendStageConversion } from "./stage-conversion";
import { logLeadActivity } from "./activity-log";
import { markBotBlocked } from "./bot-block";

export type NodeType = "message" | "action" | "entry" | "ai" | "delay" | "condition" | "conversion";

// 'conversion' nodes only — marks the lead as having reached one stage of the
// analytics funnel. Carrying a money value off a variable comes later; for
// now entering the node is the whole signal.
export interface ConversionConfig {
  stage_id?: string;
}

export interface DelayConfig {
  delay_mode?: "relative" | "exact";
  delay_hours?: number;
  delay_minutes?: number;
  delay_time?: string;
  delay_tz?: string;
}

const DEFAULT_DELAY_TZ = "Europe/Kyiv";

// How far a wall-clock instant in `timeZone` sits from UTC at that moment —
// derived from Intl rather than a table, so DST is handled by the platform.
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  return Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second")) - utcMs;
}

// UTC timestamp for a wall-clock time in `timeZone`. Resolved twice because
// the offset itself depends on the instant (DST boundaries).
function zonedWallClockToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const first = tzOffsetMs(guess, timeZone);
  const ts = guess - first;
  const second = tzOffsetMs(ts, timeZone);
  return second === first ? ts : guess - second;
}

// Exported for testing. Returns the instant this delay node should resume at.
export function computeDelayUntil(config: DelayConfig, now: Date = new Date()): Date {
  if (config.delay_mode === "exact") {
    const timeZone = config.delay_tz?.trim() || DEFAULT_DELAY_TZ;
    const [rawH, rawM] = (config.delay_time ?? "09:00").split(":");
    const hh = Math.min(23, Math.max(0, Number(rawH) || 0));
    const mm = Math.min(59, Math.max(0, Number(rawM) || 0));

    // Today's date as it reads in that timezone right now.
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (type: string) => Number(local.find((p) => p.type === type)?.value ?? "0");

    let ts = zonedWallClockToUtc(get("year"), get("month"), get("day"), hh, mm, timeZone);
    // Already gone today — take tomorrow. Date.UTC normalises month/year rollover.
    if (ts <= now.getTime()) {
      ts = zonedWallClockToUtc(get("year"), get("month"), get("day") + 1, hh, mm, timeZone);
    }
    return new Date(ts);
  }

  const hours = Number(config.delay_hours) || 0;
  const minutes = Number(config.delay_minutes) || 0;
  const totalMs = Math.max(0, hours * 60 + minutes) * 60_000;
  return new Date(now.getTime() + totalMs);
}

// actionType "edge" (default, omitted for older saved buttons too) connects
// to the next node via a source Handle, resolved by resolveNextNode. "link"
// renders as a direct URL button instead — Telegram never sends a callback
// for those, so processGraphState's button-click handling above naturally
// never sees a link button's id (untouched, no change needed there).
export interface FunnelButton {
  id: string;
  label: string;
  actionType?: "edge" | "link";
  url?: string;
}

export type AttachmentType = "photo" | "video" | "video_note" | "audio" | "animation" | "document" | "voice" | "poll";

export interface MessageAttachment {
  type: AttachmentType;
  url: string;
}

interface TelegramBlock {
  id?: string;
  kind?: "text" | "attachment";
  text?: string;
  type?: AttachmentType;
  url?: string;
  filename?: string;
}

// The block-based editor stores an ordered list of blocks (one text block +
// zero or more attachment blocks, reorderable). Pre-block saves (real,
// already-live data) still have the flat { text, attachments } shape —
// both are optional here so either can be read; toTelegramMarkdownV2 below
// still only ever sees the resolved plain text.
export interface TelegramChannelConfig {
  formatting: "markdown_v2";
  blocks?: TelegramBlock[];
  text?: string;
  attachments?: MessageAttachment[];
}

export interface MessageConfig {
  /** Strip the inline keyboard off the message once a button has been used. */
  clear_buttons_after_use?: boolean;
  // whatsapp uses the same block shape as telegram — the builder writes both
  // through the same editor; only the formatting marks differ.
  channels?: { telegram: TelegramChannelConfig | null; whatsapp: TelegramChannelConfig | null; fbm: null };
  buttons?: FunnelButton[];
}

export interface ActionConfig {
  action_type?: "set_tag" | "set_variable" | "subscribe" | "unsubscribe" | "open_chat" | "close_chat";
  payload?: Record<string, unknown>;
}

// Branch node. Each rule looks at one piece of lead state; `combinator`
// joins them. Rules are stored as-is from the builder, so every field is
// optional here — an incomplete rule is treated as unsatisfied rather than
// throwing (see evaluateCondition).
export type ConditionCombinator = "and" | "or";
export type ConditionKind = "tag" | "variable";
export type TagOperator = "has" | "not_has";
export type VariableOperator = "eq" | "neq" | "contains";

export interface ConditionRule {
  id?: string;
  kind?: ConditionKind;
  tag_op?: TagOperator;
  tag_id?: string;
  var_op?: VariableOperator;
  variable_def_id?: string;
  value?: string;
}

export interface ConditionConfig {
  combinator?: ConditionCombinator;
  conditions?: ConditionRule[];
}

// Handle ids on the condition node's two outgoing edges. Stored in
// funnel_edges.from_button_id, the same column button edges use — a condition
// node has no buttons, so there's no collision.
export const CONDITION_TRUE = "condition_true";
export const CONDITION_FALSE = "condition_false";

// Comparisons are trimmed and case-insensitive: variable values are typed by
// leads and by managers, so "Київ" and "київ " should match.
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesVariable(stored: string | null, rule: ConditionRule): boolean {
  const expected = normalize(rule.value ?? "");
  // No row at all means the lead never got this variable set. "Not equal" is
  // then vacuously true; "equals"/"contains" have nothing to match.
  if (stored === null) return rule.var_op === "neq";
  const actual = normalize(stored);
  switch (rule.var_op) {
    case "neq":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    case "eq":
    default:
      return actual === expected;
  }
}

// Reads the lead's tags and variables once, then evaluates every rule in
// memory — a node with ten rules still costs two queries.
export async function evaluateCondition(
  supabase: SupabaseClient,
  config: ConditionConfig,
  leadId: string | null,
): Promise<boolean> {
  const rules = config.conditions ?? [];
  // Nothing configured yet: behave as a pass-through rather than dead-ending
  // every lead down the "Ні" branch.
  if (rules.length === 0) return true;

  const combinator: ConditionCombinator = config.combinator === "or" ? "or" : "and";

  // Without a lead there is no state to test, so no rule can be satisfied.
  if (!leadId) return false;

  const needsTags = rules.some((r) => r.kind !== "variable");
  const needsVariables = rules.some((r) => r.kind === "variable");

  const tagIds = new Set<string>();
  if (needsTags) {
    const { data } = await supabase.from("lead_tags").select("tag_id").eq("lead_id", leadId);
    for (const row of data ?? []) tagIds.add(row.tag_id as string);
  }

  const variableValues = new Map<string, string | null>();
  if (needsVariables) {
    const { data } = await supabase.from("lead_variables").select("variable_def_id, value").eq("lead_id", leadId);
    for (const row of data ?? []) variableValues.set(row.variable_def_id as string, (row.value as string | null) ?? null);
  }

  const results = rules.map((rule) => {
    if (rule.kind === "variable") {
      // An unfinished rule (no variable picked) can't be satisfied.
      if (!rule.variable_def_id) return false;
      const stored = variableValues.has(rule.variable_def_id) ? variableValues.get(rule.variable_def_id)! : null;
      return matchesVariable(stored, rule);
    }
    if (!rule.tag_id) return false;
    const present = tagIds.has(rule.tag_id);
    return rule.tag_op === "not_has" ? !present : present;
  });

  return combinator === "or" ? results.some(Boolean) : results.every(Boolean);
}

export interface ClaimedState {
  id: string;
  thread_id: string;
  org_id: string;
  funnel_id: string;
  funnel_node_id: string | null;
}

// Set only when a state's *fresh* entry-node arrival was caused by a lead-gen
// link click (telegram-webhook.ts's enrollment flow) — the cron path and
// button-click advances never pass this. See maybeSendMetaConversion below.
export interface EnrollmentContext {
  linkId: string;
  clickId: string | null;
}

export interface ProcessOptions {
  // The caller has *just* written funnel_node_id (manual move/attach, a
  // lead-gen enrollment, an AI node's exit) and invokes the walk straight
  // away. The start node then counts as a fresh arrival — a delay parks
  // instead of being treated as already waited out. The cron never sets it:
  // a state it claims has been sitting on its node until waiting_until.
  freshPlacement?: boolean;
}

interface EntryConfig {
  track_as_conversion?: boolean;
}

// Entry-node config's own Meta flag, gated further by whether the specific
// link clicked has a pixel configured and the org has connected Meta at all.
// Any of the three missing means: no user-facing error (a lead's onboarding
// must never fail over an ad-tracking setting), but if there was clear intent
// (the toggle is on) and something else is missing, that's worth surfacing —
// logged to `events` so it's diagnosable instead of a silent no-op forever.
async function maybeSendMetaConversion(
  supabase: SupabaseClient,
  state: ClaimedState,
  entryConfig: EntryConfig,
  enrollment: EnrollmentContext,
): Promise<void> {
  if (!entryConfig.track_as_conversion) return;

  // Gate and credential live on the same row now — one query instead of two.
  // Each link carries its own independent token, so this check (and the send
  // below) never touches any other link's credential, even in the same org.
  const { data: link, error: linkError } = await supabase
    .from("lead_gen_links")
    .select("pixel_id, ref_token, meta_access_token_secret_id")
    .eq("id", enrollment.linkId)
    .maybeSingle();

  if (linkError) console.error("funnel-graph: lead_gen_links lookup failed", linkError);

  const pixelId = (link?.pixel_id as string | null) ?? null;
  if (!pixelId) {
    await logMetaCapiSkip(supabase, state.org_id, "no_pixel_id", enrollment);
    return;
  }

  if (!link?.meta_access_token_secret_id) {
    await logMetaCapiSkip(supabase, state.org_id, "no_token", enrollment);
    return;
  }

  // Meta's business_messaging action_source requires a messaging_channel
  // value it recognises (messenger/whatsapp/instagram) — meta-capi-send.ts
  // needs to know which of our three channels this lead is actually on to
  // pick the right one (or fall back to a channel that doesn't need it).
  const { data: thread, error: threadLookupError } = await supabase
    .from("threads")
    .select("channel_type")
    .eq("id", state.thread_id)
    .maybeSingle();
  if (threadLookupError) console.error("funnel-graph: threads lookup failed", threadLookupError);
  const channelType = (thread?.channel_type as string | undefined) ?? null;

  let click: { fbclid: string | null; ip: string | null; user_agent: string | null; clicked_at: string } | null = null;
  if (enrollment.clickId) {
    const { data, error } = await supabase
      .from("link_clicks")
      .select("fbclid, ip, user_agent, clicked_at")
      .eq("click_id", enrollment.clickId)
      .maybeSingle();
    if (error) console.error("funnel-graph: link_clicks lookup failed", error);
    click = data ?? null;
  }

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    console.error("funnel-graph: URL сайту не сконфігуровано, не можу викликати meta-capi-send");
    return;
  }

  try {
    await fetch(`${siteUrl}/.netlify/functions/meta-capi-send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        linkId: enrollment.linkId,
        pixelId,
        channelType,
        fbclid: click?.fbclid ?? null,
        clickTimestampMs: click ? new Date(click.clicked_at).getTime() : null,
        ip: click?.ip ?? null,
        userAgent: click?.user_agent ?? null,
        // Best available stand-in for the page the visitor clicked from —
        // the redirect link itself, not the actual landing page (which
        // isn't known server-side).
        eventSourceUrl: link?.ref_token ? `${siteUrl}/r/${link.ref_token}` : null,
        // Ties this event to the click so a retried enrollment call
        // (funnel-advance's own fetch to us failing and Telegram retrying the
        // webhook) dedupes on Meta's side instead of double-counting.
        eventId: enrollment.clickId ?? state.id,
      }),
    });
  } catch (err) {
    console.error("funnel-graph: meta-capi-send invoke failed", err);
  }
}

async function logMetaCapiSkip(
  supabase: SupabaseClient,
  orgId: string,
  reason: "no_pixel_id" | "no_token",
  enrollment: EnrollmentContext,
): Promise<void> {
  const { error } = await supabase.from("events").insert({
    org_id: orgId,
    type: "meta_capi_skipped",
    level: "warn",
    payload: { reason, link_id: enrollment.linkId, click_id: enrollment.clickId },
  });
  if (error) console.error("funnel-graph: events insert failed", error);
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
}

// Returned by every Telegram send path (plain text, single attachment, the
// multi-attachment sequence) so sendGraphMessage can react to a 403
// ("Forbidden: bot was blocked by the user") no matter which path hit it,
// without each of those paths knowing about leads.blocked_bot itself.
interface TelegramSendResult {
  ok: boolean;
  errorCode?: number;
}

// ---------- Telegram MarkdownV2 conversion ----------
// MarkdownV2 requires every one of `_*[]()~\`>#+-=|{}.!\` to be
// backslash-escaped outside of deliberate formatting entities. We split the
// text on our own *bold*/_italic_/`code`/||spoiler|| marks, escape the plain
// segments in full, and escape only the *inside* of each mark (the
// delimiters themselves are already valid MarkdownV2 syntax).
const MARKDOWNV2_ESCAPE_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const MARK_TOKEN_RE = /(\*[^*\n]+?\*|_[^_\n]+?_|`[^`\n]+?`|\|\|[^|\n]+?\|\|)/g;
const MARK_DELIMS = ["||", "*", "_", "`"];

function escapeMarkdownV2Plain(text: string): string {
  return text.replace(MARKDOWNV2_ESCAPE_RE, (c) => `\\${c}`);
}

// Inside a code span, MarkdownV2 only requires '`' and '\' to be escaped —
// the content is displayed literally, not parsed for further entities.
function escapeMarkdownV2Code(text: string): string {
  return text.replace(/[`\\]/g, (c) => `\\${c}`);
}

// The builder's formatting toolbar can nest marks (e.g. *_bold italic_* —
// bold containing italic) — recurse into each mark's inner content so those
// nested delimiters are preserved as real entities instead of being escaped
// away as plain text. Code spans are the one exception: their content stays
// literal, never re-parsed for nested marks.
function toTelegramMarkdownV2(raw: string): string {
  return raw
    .split(MARK_TOKEN_RE)
    .map((part) => {
      if (!part) return "";
      for (const delim of MARK_DELIMS) {
        if (part.startsWith(delim) && part.endsWith(delim) && part.length > delim.length * 2) {
          const inner = part.slice(delim.length, -delim.length);
          return delim + (delim === "`" ? escapeMarkdownV2Code(inner) : toTelegramMarkdownV2(inner)) + delim;
        }
      }
      return escapeMarkdownV2Plain(part);
    })
    .join("");
}

// video_note/poll take no caption in the Bot API — their text (if any) has
// nowhere to go on the same call, so it's simply not sent for those types
// (MVP scope; matches "one field per attachment" from the builder UI).
const ATTACHMENT_METHODS: Record<Exclude<AttachmentType, "poll">, { method: string; field: string; supportsCaption: boolean }> = {
  photo: { method: "sendPhoto", field: "photo", supportsCaption: true },
  video: { method: "sendVideo", field: "video", supportsCaption: true },
  video_note: { method: "sendVideoNote", field: "video_note", supportsCaption: false },
  audio: { method: "sendAudio", field: "audio", supportsCaption: true },
  animation: { method: "sendAnimation", field: "animation", supportsCaption: true },
  document: { method: "sendDocument", field: "document", supportsCaption: true },
  voice: { method: "sendVoice", field: "voice", supportsCaption: true },
};

// Resolves either config shape (block list or the older flat fields) down to
// plain text + an ordered attachment list, in the order the builder's
// drag-reorderable block list has them.
function getChannelContent(channel: TelegramChannelConfig): { text: string; attachments: MessageAttachment[] } {
  if (Array.isArray(channel.blocks)) {
    const textBlock = channel.blocks.find((b) => b.kind === "text");
    const attachments = channel.blocks
      .filter((b) => b.kind === "attachment" && b.type && b.url)
      .map((b) => ({ type: b.type as AttachmentType, url: b.url as string }));
    return { text: textBlock?.text ?? "", attachments };
  }
  return { text: channel.text ?? "", attachments: channel.attachments ?? [] };
}

type InlineKeyboardButton = { text: string; url: string } | { text: string; callback_data: string };
type ReplyMarkup = { inline_keyboard: InlineKeyboardButton[][] } | undefined;

// "link" buttons open a URL directly and never generate a callback_query;
// "edge" (default, including buttons saved before this existed) keep the
// existing callback_data behaviour that resolveNextNode matches on.
function buildReplyMarkup(buttons: FunnelButton[] | undefined): ReplyMarkup {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((b) =>
      b.actionType === "link" && b.url ? [{ text: b.label, url: b.url }] : [{ text: b.label, callback_data: b.id }],
    ),
  };
}

// Guards a single invocation against looping forever on a malformed graph
// (e.g. a cycle of action nodes with no message/dead-end).
const MAX_NODE_ADVANCES = 50;
// How long a message-with-buttons node "pauses" a state for, awaiting a
// callback_query. There's no dedicated status for this (funnel_states.status
// stays 'active') — resolveNextNode via the button click is what un-pauses it.
const AWAITING_INPUT_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

// Asks ai-respond for the opening message. Kept as an HTTP hop (rather than
// calling the model here) so every OpenRouter call still goes through the one
// function that owns keys, history, tools and send/logging.
//
// stateId names exactly which funnel_states row this opening belongs to — a
// thread can have more than one 'ai_active' row at once (a lead enrolled in
// several funnels), so ai-respond.ts must not have to guess by thread_id alone.
async function triggerAiOpening(threadId: string, stateId: string): Promise<void> {
  const siteUrl = process.env.URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!siteUrl || !serviceRoleKey) {
    console.error("funnel-graph: URL/service key missing, cannot request AI opening message");
    return;
  }

  try {
    await fetch(`${siteUrl}/.netlify/functions/ai-respond`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
      body: JSON.stringify({ threadId, stateId, opening: true }),
    });
  } catch (err) {
    // Non-fatal: the state is already ai_active, so the lead's next message
    // still gets answered normally.
    console.error("funnel-graph: AI opening request failed", err);
  }
}

// Shared shape for the one thread/lead lookup that both clearInlineKeyboard
// and sendGraphMessage need — see the caching in processGraphState below.
// lead_id is only used by sendGraphMessage's 403 fallback.
type ThreadChannelInfo = { channel_type: string; external_id: string | null; lead_id: string | null };

export async function resolveNextNode(
  supabase: SupabaseClient,
  currentNodeId: string,
  chosenButtonId: string | null,
): Promise<string | null> {
  let query = supabase.from("funnel_edges").select("to_node_id").eq("from_node_id", currentNodeId);
  query = chosenButtonId ? query.eq("from_button_id", chosenButtonId) : query.is("from_button_id", null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  return data.to_node_id as string;
}

export async function processGraphState(
  supabase: SupabaseClient,
  state: ClaimedState,
  chosenButtonId: string | null,
  enrollment: EnrollmentContext | null = null,
  // Telegram's id for the message whose button was tapped. Comes straight from
  // callback_query, so nothing has to be stored at send time to support
  // clearing the keyboard afterwards.
  callbackMessageId: number | null = null,
  options: ProcessOptions = {},
) {
  if (!state.funnel_node_id) {
    console.error("funnel-graph: state has no funnel_node_id", state.id);
    return;
  }

  let nodeId: string | null = state.funnel_node_id;

  // clearInlineKeyboard and sendGraphMessage used to each independently fetch
  // the thread/lead lookup and, for Telegram, the credential + decrypted bot
  // token — up to 3 redundant sequential round-trips whenever a button click
  // with clear_buttons_after_use was immediately followed by a message send
  // in the same walk. Cached per processGraphState call so either call site
  // (or repeated message sends in one walk) pays for the lookup only once.
  let threadInfoPromise: Promise<ThreadChannelInfo | null> | null = null;
  let botTokenPromise: Promise<string | null> | null = null;

  function loadThreadInfo(): Promise<ThreadChannelInfo | null> {
    if (!threadInfoPromise) {
      threadInfoPromise = (async () => {
        const { data, error } = await supabase
          .from("threads")
          .select("channel_type, leads ( id, external_id )")
          .eq("id", state.thread_id)
          .eq("org_id", state.org_id)
          .maybeSingle();
        if (error || !data) return null;
        const leads = (data as unknown as { leads: { id: string; external_id: string } | null }).leads;
        return {
          channel_type: data.channel_type as string,
          external_id: leads?.external_id ?? null,
          lead_id: leads?.id ?? null,
        };
      })();
    }
    return threadInfoPromise;
  }

  function loadBotToken(channelType: string): Promise<string | null> {
    if (!botTokenPromise) {
      botTokenPromise = (async () => {
        // Only Telegram sends go through the bot-token/credential path below —
        // WhatsApp is delegated whole to whatsapp-send.ts and never needs it.
        if (channelType !== "telegram") return null;
        const { data: credential } = await supabase
          .from("channel_credentials")
          .select("bot_token_secret_id")
          .eq("org_id", state.org_id)
          .eq("channel_type", "telegram")
          .maybeSingle();
        if (!credential?.bot_token_secret_id) return null;
        const { data: token } = await supabase.rpc("vault_read_secret", {
          secret_id: credential.bot_token_secret_id,
        });
        return (token as string) ?? null;
      })();
    }
    return botTokenPromise;
  }

  async function loadThreadContext(): Promise<{ threadInfo: ThreadChannelInfo | null; botToken: string | null }> {
    const threadInfo = await loadThreadInfo();
    const botToken = threadInfo ? await loadBotToken(threadInfo.channel_type) : null;
    return { threadInfo, botToken };
  }

  // Arriving via a button click: record what the lead picked, then move past
  // the message node they were parked on.
  if (chosenButtonId) {
    const { data: currentNode } = await supabase.from("funnel_nodes").select("config").eq("id", nodeId).maybeSingle();
    const config = (currentNode?.config ?? {}) as MessageConfig;
    const buttons = (config.buttons ?? []) as FunnelButton[];
    const chosen = buttons.find((b) => b.id === chosenButtonId);

    // Telegram leaves an inline keyboard live forever, so a lead can tap a
    // button on a message the funnel has long since moved past. That tap
    // carries a button id belonging to an earlier node, and treating it as a
    // choice on the current one used to end the funnel outright: one impatient
    // double-tap and the lead stopped receiving anything (seen in production —
    // 4h46m of silence until an operator intervened by hand).
    //
    // A stale tap is not a decision. Keep it in the transcript for the record,
    // change nothing else, and let the lead stay exactly where they were.
    if (!chosen) {
      await supabase.from("messages").insert({
        org_id: state.org_id,
        thread_id: state.thread_id,
        direction: "inbound",
        body: "",
        sender: "lead",
        // No button_click marker: there is no label to show, and rendering the
        // raw id was the "натиснув «6517cdfd»" nonsense in the chat.
        meta: { type: "stale_button_click", button_id: chosenButtonId, node_id: nodeId },
      });
      console.error("funnel-graph: ignoring button from a different node", { stateId: state.id, nodeId, chosenButtonId });
      return;
    }

    // Recording the click and resolving where it leads don't depend on each
    // other — run them together instead of one after the other.
    const [, nextId] = await Promise.all([
      supabase.from("messages").insert({
        org_id: state.org_id,
        thread_id: state.thread_id,
        direction: "inbound",
        body: chosen.label,
        sender: "lead",
        // Marks this as a button tap rather than typed text, so the chat can
        // render it as a system marker instead of a normal lead bubble.
        meta: { type: "button_click", label: chosen.label },
      }),
      resolveNextNode(supabase, nodeId, chosenButtonId),
    ]);
    if (!nextId) {
      // The button is real but its branch was never drawn — a genuine gap in
      // the graph, unlike the stale tap above. Recorded so it shows up in
      // /admin/security instead of only as a lead who quietly stopped.
      const { error: eventError } = await supabase.from("events").insert({
        org_id: state.org_id,
        type: "button_edge_not_connected",
        // error, not warn: the lead is out of the funnel for good, which is a
        // worse outcome than the warnings around it. Keeps the severity in the
        // admin catalog consistent with the level stored here.
        level: "error",
        payload: {
          button_id: chosenButtonId,
          button_label: chosen.label,
          thread_id: state.thread_id,
          funnel_state_id: state.id,
          funnel_node_id: nodeId,
        },
      });
      if (eventError) console.error("funnel-graph: events insert failed", eventError);

      await supabase.from("funnel_states").update({ status: "completed" }).eq("id", state.id);
      return;
    }

    // Optional per-node cleanup: strip the keyboard off the message that was
    // just answered, so it can't be tapped again at all. Fire-and-forget —
    // it's cosmetic, its own failure is already just logged, and it must not
    // hold up the walk to the next node.
    if (config.clear_buttons_after_use) {
      const { threadInfo, botToken } = await loadThreadContext();
      clearInlineKeyboard(supabase, state, callbackMessageId, threadInfo, botToken).catch((err) =>
        console.error("funnel-graph: clearInlineKeyboard failed", err),
      );
    }

    nodeId = nextId;
  }

  let advances = 0;
  while (nodeId && advances < MAX_NODE_ADVANCES) {
    advances++;

    const { data: node, error: nodeError } = await supabase
      .from("funnel_nodes")
      .select("id, type, config")
      .eq("id", nodeId)
      .single();

    if (nodeError || !node) {
      console.error("funnel-graph: node not found", nodeId, nodeError);
      await supabase.from("funnel_states").update({ status: "stopped" }).eq("id", state.id);
      return;
    }

    const type = node.type as NodeType;

    if (type === "entry") {
      // Only telegram-webhook.ts's lead-gen-link flow ever passes enrollment,
      // and only on this exact call — fires once per link click, never on a
      // later cron pass or button-click advance through the same state.
      if (enrollment) {
        await maybeSendMetaConversion(supabase, state, (node.config ?? {}) as EntryConfig, enrollment);
      }

      const nextId = await resolveNextNode(supabase, nodeId, null);
      if (!nextId) {
        await supabase.from("funnel_states").update({ status: "completed", funnel_node_id: nodeId }).eq("id", state.id);
        return;
      }
      nodeId = nextId;
      continue;
    }

    if (type === "action") {
      await runAction(supabase, state, node.config as ActionConfig);
      const nextId = await resolveNextNode(supabase, nodeId, null);
      if (!nextId) {
        await supabase.from("funnel_states").update({ status: "completed", funnel_node_id: nodeId }).eq("id", state.id);
        return;
      }
      nodeId = nextId;
      continue;
    }

    if (type === "message") {
      const config = node.config as MessageConfig;

      // Persist progress *before* attempting to send: if this fails partway
      // and gets retried after the lease expires, the retry must resume at
      // this message node — not re-run whatever entry/action nodes preceded
      // it (harmless for those idempotent actions, but re-sending a message
      // on retry would visibly duplicate it for the lead).
      await supabase.from("funnel_states").update({ funnel_node_id: nodeId }).eq("id", state.id);

      const { threadInfo, botToken } = await loadThreadContext();
      const sent = await sendGraphMessage(supabase, state, config, threadInfo, botToken);
      if (!sent) {
        // Leave the row as-is — the claim already leased it for 2 minutes,
        // so it'll be retried automatically without a 4th status.
        return;
      }

      // Only pause if at least one button can actually trigger a callback —
      // "link" buttons open a URL directly and never send one, so a message
      // with exclusively link buttons has nothing to wait for and should
      // advance immediately, same as a message with no buttons at all.
      const hasEdgeButton = (config.buttons ?? []).some((b) => b.actionType !== "link");
      if (hasEdgeButton) {
        // Pause here: this node stays "current" until a callback_query
        // resolves it forward (see resolveNextNode above).
        await supabase
          .from("funnel_states")
          .update({ funnel_node_id: nodeId, waiting_until: new Date(Date.now() + AWAITING_INPUT_PAUSE_MS).toISOString() })
          .eq("id", state.id);
        return;
      }

      const nextId = await resolveNextNode(supabase, nodeId, null);
      if (!nextId) {
        await supabase.from("funnel_states").update({ status: "completed", funnel_node_id: nodeId }).eq("id", state.id);
        return;
      }
      nodeId = nextId;
      continue;
    }

    // Hand-off node: park the state here and stop walking. 'ai_active' is
    // deliberately not 'active', so claim_due_graph_funnel_states never picks
    // this state up again — from here on, telegram-webhook.ts routes each
    // inbound message to ai-respond.ts instead of the graph advancing on its
    // own. Exit edges come later, together with tool-calling.
    // Unconditional single-exit pause. Ways to reach a delay node:
    //   - stepping into it mid-walk (or via a button's edge): a fresh
    //     arrival, so park.
    //   - it's the node the walk starts on. Whether the wait is already
    //     served can't be read off the walk itself — the cron claiming a due
    //     state and a caller that just placed the lead here look identical
    //     at this point (first advance, same node), which is exactly how a
    //     manual move onto a delay used to skip it. So the caller says so:
    //     options.freshPlacement → park; otherwise (the cron, which only
    //     claims states whose waiting_until is due) → served, walk on.
    // Parking reuses the existing waiting_until mechanism (status stays
    // 'active'); no new scheduling machinery.
    if (type === "delay") {
      const isStartNode = advances === 1 && nodeId === state.funnel_node_id;
      const arrivedFresh = !isStartNode || options.freshPlacement === true;

      if (arrivedFresh) {
        const until = computeDelayUntil((node.config ?? {}) as DelayConfig);
        await supabase
          .from("funnel_states")
          .update({ funnel_node_id: nodeId, waiting_until: until.toISOString() })
          .eq("id", state.id);
        return;
      }

      const nextId = await resolveNextNode(supabase, nodeId, null);
      if (!nextId) {
        await supabase.from("funnel_states").update({ status: "completed", funnel_node_id: nodeId }).eq("id", state.id);
        return;
      }
      nodeId = nextId;
      continue;
    }

    // Branch node. Unlike delay this never parks: the answer depends only on
    // state that already exists, so it resolves and walks on in the same pass.
    if (type === "condition") {
      const { data: thread } = await supabase.from("threads").select("lead_id").eq("id", state.thread_id).maybeSingle();
      const leadId = (thread?.lead_id as string | undefined) ?? null;
      const passed = await evaluateCondition(supabase, (node.config ?? {}) as ConditionConfig, leadId);

      const nextId = await resolveNextNode(supabase, nodeId, passed ? CONDITION_TRUE : CONDITION_FALSE);
      if (!nextId) {
        // The taken branch isn't wired up — that's the end of the road for
        // this lead, not an error worth retrying.
        await supabase.from("funnel_states").update({ status: "completed", funnel_node_id: nodeId }).eq("id", state.id);
        return;
      }
      nodeId = nextId;
      continue;
    }

    // Analytics marker. Like condition (and unlike delay) this never parks:
    // recording the stage depends on nothing external, so it writes and walks
    // on in the same pass. A missing/misconfigured stage_id is not fatal —
    // the lead keeps moving, only the marker is skipped.
    if (type === "conversion") {
      const config = (node.config ?? {}) as ConversionConfig;
      const { data: thread } = await supabase.from("threads").select("lead_id").eq("id", state.thread_id).maybeSingle();
      const leadId = (thread?.lead_id as string | undefined) ?? null;

      if (leadId && config.stage_id) {
        await recordStageEntry(supabase, state.org_id, leadId, config.stage_id);
      } else {
        console.error("funnel-graph: conversion node without stage_id or lead", nodeId);
      }

      const nextId = await resolveNextNode(supabase, nodeId, null);
      if (!nextId) {
        await supabase.from("funnel_states").update({ status: "completed", funnel_node_id: nodeId }).eq("id", state.id);
        return;
      }
      nodeId = nextId;
      continue;
    }

    if (type === "ai") {
      await supabase.from("funnel_states").update({ status: "ai_active", funnel_node_id: nodeId }).eq("id", state.id);
      // Speak first. Without this the node went silent on entry, which dead-
      // ended any funnel handing over right after a button click: the lead saw
      // the bot stop, never typed again, so ai-respond was never triggered.
      await triggerAiOpening(state.thread_id, state.id);
      return;
    }

    console.error("funnel-graph: unsupported node type, stopping", nodeId, type);
    await supabase.from("funnel_states").update({ status: "stopped", funnel_node_id: nodeId }).eq("id", state.id);
    return;
  }

  // Hit the advance-count guard (or ran out of nodeId unexpectedly) — leave
  // it due again shortly rather than losing track of progress.
  if (nodeId) {
    await supabase
      .from("funnel_states")
      .update({ funnel_node_id: nodeId, waiting_until: new Date().toISOString() })
      .eq("id", state.id);
  }
}

// Point addition alongside the subscribe/unsubscribe action below — an
// analytics trail for /dashboard/analytics, not part of the funnel walk
// itself. link_id is a snapshot of the lead's own attribution at the time of
// the event, not looked up again later, so a lead re-clicking through a
// different link doesn't retroactively rewrite past events' source.
async function logSubscriptionEvent(
  supabase: SupabaseClient,
  orgId: string,
  leadId: string,
  eventType: "subscribe" | "unsubscribe",
) {
  const { data: lead } = await supabase.from("leads").select("source_link_id").eq("id", leadId).maybeSingle();

  const { error } = await supabase.from("lead_subscription_events").insert({
    org_id: orgId,
    lead_id: leadId,
    link_id: (lead?.source_link_id as string | null) ?? null,
    event_type: eventType,
  });
  if (error) console.error("funnel-graph: lead_subscription_events insert failed", error);
}

// Writes one entry into the lead's stage trail and repoints leads
// .current_stage_id at it. Append-only by design: the history is what
// analytics (and, later, CAPI) read, so revisiting a stage adds a row rather
// than replacing one. value stays null until conversion nodes learn to pull
// an amount off a variable.
async function recordStageEntry(supabase: SupabaseClient, orgId: string, leadId: string, stageId: string) {
  const { data: historyRow, error: historyError } = await supabase
    .from("lead_stage_history")
    .insert({ org_id: orgId, lead_id: leadId, stage_id: stageId, value: null })
    .select("id, entered_at")
    .single();
  if (historyError || !historyRow) {
    console.error("funnel-graph: lead_stage_history insert failed", historyError);
    return;
  }

  const { error: leadError } = await supabase
    .from("leads")
    .update({ current_stage_id: stageId })
    .eq("id", leadId)
    .eq("org_id", orgId);
  if (leadError) console.error("funnel-graph: current_stage_id update failed", leadError);

  const { data: stageRow } = await supabase.from("funnel_stages").select("name").eq("id", stageId).maybeSingle();
  await logLeadActivity(supabase, {
    orgId,
    leadId,
    actionType: "stage_changed",
    actorType: "system",
    details: { from_stage: null, to_stage: (stageRow?.name as string | undefined) ?? null, value: null },
  });

  // Same shared dispatch every other writer of lead_stage_history uses; a
  // no-op unless the stage itself is configured to track conversions.
  await maybeSendStageConversion(supabase, {
    historyId: historyRow.id as string,
    orgId,
    leadId,
    stageId,
    value: null,
    enteredAt: historyRow.entered_at as string,
  });
}

async function runAction(supabase: SupabaseClient, state: ClaimedState, config: ActionConfig) {
  const payload = config.payload ?? {};

  const { data: thread } = await supabase.from("threads").select("lead_id").eq("id", state.thread_id).maybeSingle();
  const leadId = thread?.lead_id as string | undefined;

  switch (config.action_type) {
    case "set_tag": {
      // payload carries tag_id (FK into the org's tags catalog) rather than a
      // free-text tag — see /dashboard/elements for where tags are managed.
      const tagId = payload.tag_id as string | undefined;
      if (!leadId || !tagId) break;
      await supabase
        .from("lead_tags")
        .upsert({ lead_id: leadId, org_id: state.org_id, tag_id: tagId }, { onConflict: "lead_id,tag_id" });

      // Logged alongside the write, exactly as the manual path does it in
      // save-lead-tag.ts — the timeline shouldn't care who set the tag.
      const { data: tagRow } = await supabase.from("tags").select("name").eq("id", tagId).maybeSingle();
      await logLeadActivity(supabase, {
        orgId: state.org_id,
        leadId,
        actionType: "tag_added",
        actorType: "system",
        details: { tag_name: (tagRow?.name as string | undefined) ?? null },
      });
      break;
    }
    case "set_variable": {
      // payload carries variable_def_id (FK into the org's variable_defs
      // catalog) rather than a free-text key — see /dashboard/elements.
      const variableDefId = payload.variable_def_id as string | undefined;
      const value = payload.value as string | undefined;
      if (!leadId || !variableDefId) break;

      const { data: prevVar } = await supabase
        .from("lead_variables")
        .select("value")
        .eq("lead_id", leadId)
        .eq("variable_def_id", variableDefId)
        .maybeSingle();

      await supabase.from("lead_variables").upsert(
        { lead_id: leadId, org_id: state.org_id, variable_def_id: variableDefId, value: value ?? null, updated_at: new Date().toISOString() },
        { onConflict: "lead_id,variable_def_id" },
      );

      const { data: defRow } = await supabase.from("variable_defs").select("label").eq("id", variableDefId).maybeSingle();
      await logLeadActivity(supabase, {
        orgId: state.org_id,
        leadId,
        actionType: "variable_changed",
        actorType: "system",
        details: {
          key: (defRow?.label as string | undefined) ?? null,
          old_value: (prevVar?.value as string | null | undefined) ?? null,
          new_value: value ?? null,
        },
      });
      break;
    }
    case "subscribe":
      if (leadId) {
        await supabase.from("leads").update({ subscribed: true }).eq("id", leadId);
        await logSubscriptionEvent(supabase, state.org_id, leadId, "subscribe");
      }
      break;
    case "unsubscribe":
      if (leadId) {
        await supabase.from("leads").update({ subscribed: false }).eq("id", leadId);
        await logSubscriptionEvent(supabase, state.org_id, leadId, "unsubscribe");
      }
      break;
    case "open_chat":
      await supabase.from("threads").update({ status: "open" }).eq("id", state.thread_id);
      // Handing the thread to a human also ends any AI hand-off on it: those
      // states are marked 'stopped' rather than 'active', since re-activating
      // would just have the walker park them right back on the same ai node.
      // A no-op when the thread was never in AI mode.
      await supabase
        .from("funnel_states")
        .update({ status: "stopped" })
        .eq("thread_id", state.thread_id)
        .eq("status", "ai_active");
      break;
    case "close_chat":
      await supabase.from("threads").update({ status: "closed" }).eq("id", state.thread_id);
      break;
    default:
      console.error("funnel-graph: unknown action_type", config.action_type);
  }
}

async function sendGraphMessage(
  supabase: SupabaseClient,
  state: ClaimedState,
  config: MessageConfig,
  threadInfo: ThreadChannelInfo | null,
  botToken: string | null,
): Promise<boolean> {
  if (!threadInfo) {
    console.error("funnel-graph: thread not found", state.thread_id);
    return false;
  }

  const chatId = threadInfo.external_id;
  if (!chatId) {
    console.error("funnel-graph: lead not found for thread", state.thread_id);
    return false;
  }

  // Isolated parallel path: a WhatsApp thread is delegated whole to
  // whatsapp-send.ts, so the Telegram send/attachment logic below is
  // untouched and the 24-hour window rule stays in one place.
  if (threadInfo.channel_type === "whatsapp") {
    return sendGraphWhatsAppMessage(state, config);
  }

  const telegram = config.channels?.telegram;
  if (!telegram) {
    console.error("funnel-graph: message node with no text", state.id);
    return false;
  }
  const { text, attachments } = getChannelContent(telegram);
  if (!text) {
    console.error("funnel-graph: message node with no text", state.id);
    return false;
  }

  if (!botToken) {
    console.error("funnel-graph: no channel credential for org", state.org_id);
    return false;
  }

  const replyMarkup = buildReplyMarkup(config.buttons);
  const formattedText = toTelegramMarkdownV2(text);

  let result: TelegramSendResult;
  if (attachments.length === 0) {
    result = await callTelegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: formattedText,
      parse_mode: "MarkdownV2",
      reply_markup: replyMarkup,
    });
  } else if (attachments.length === 1) {
    result = await sendTelegramAttachment(botToken, chatId, attachments[0], formattedText, replyMarkup);
  } else {
    result = await sendTelegramAttachmentSequence(botToken, chatId, attachments, formattedText, replyMarkup);
  }

  if (!result.ok) {
    // Reactive fallback for when my_chat_member (telegram-webhook.ts) didn't
    // arrive or hasn't landed yet — best effort, never blocks the return.
    if (result.errorCode === 403 && threadInfo.lead_id) {
      await markBotBlocked(supabase, state.org_id, threadInfo.lead_id, true);
    }
    return false;
  }

  // The transcript stores what the lead actually saw, not just the text:
  // Chats renders these attachments inline and the buttons as readonly pills.
  // Without them a manager reading the thread can't tell a plain message from
  // one that offered three choices.
  await supabase.from("messages").insert({
    org_id: state.org_id,
    thread_id: state.thread_id,
    direction: "outbound",
    body: text,
    sender: "system",
    meta: buildMessageMeta(attachments, config.buttons),
  });

  return true;
}

/**
 * Presentation payload for a stored message. Returns null when there's
 * nothing extra, so a plain text message keeps meta empty rather than
 * carrying two empty arrays.
 */
function buildMessageMeta(
  attachments: MessageAttachment[],
  buttons: FunnelButton[] | undefined,
): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  if (attachments.length > 0) meta.attachments = attachments;
  if (buttons && buttons.length > 0) {
    meta.buttons = buttons.map((b) => ({ id: b.id, label: b.label, actionType: b.actionType ?? "edge", url: b.url ?? null }));
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

// Falls back to the telegram block when the node has no WhatsApp-specific
// content: a funnel author who only filled one tab still expects the message
// to go out, and an empty WhatsApp tab means "same wording", not "send
// nothing". whatsapp-send.ts records the outbound message itself.
async function sendGraphWhatsAppMessage(state: ClaimedState, config: MessageConfig): Promise<boolean> {
  const channel = config.channels?.whatsapp ?? config.channels?.telegram;
  if (!channel) {
    console.error("funnel-graph: whatsapp message node with no content", state.id);
    return false;
  }

  const { text } = getChannelContent(channel);
  if (!text) {
    console.error("funnel-graph: whatsapp message node with no text", state.id);
    return false;
  }

  const siteUrl = process.env.URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!siteUrl || !serviceRoleKey) {
    console.error("funnel-graph: URL/service key не сконфігуровано, не можу викликати whatsapp-send");
    return false;
  }

  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/whatsapp-send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
      // Buttons/attachments aren't forwarded: the WhatsApp sender only ever
      // sends plain text today, so recording them would claim the lead saw
      // something they didn't.
      body: JSON.stringify({ threadId: state.thread_id, text, sender: "system" }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string } | null;

    if (!res.ok) {
      console.error("funnel-graph: whatsapp-send failed", res.status, data);
      return false;
    }

    // A shut 24-hour window is a settled outcome, not a transport failure:
    // returning true lets the walk move past this node instead of retrying a
    // send that can never succeed until the lead writes again.
    if (data?.ok === false) {
      console.error("funnel-graph: whatsapp message not delivered", data.reason);
      return true;
    }

    return true;
  } catch (err) {
    console.error("funnel-graph: whatsapp-send invoke failed", err);
    return false;
  }
}

/**
 * Removes the inline keyboard from one already-sent message.
 *
 * Best effort by design: the lead's answer is already recorded and the funnel
 * has already moved on, so a failure here must never affect the walk. Telegram
 * also rejects an edit that changes nothing ("message is not modified"), which
 * is a no-op worth ignoring rather than retrying.
 */
async function clearInlineKeyboard(
  supabase: SupabaseClient,
  state: ClaimedState,
  callbackMessageId: number | null,
  threadInfo: ThreadChannelInfo | null,
  botToken: string | null,
): Promise<void> {
  if (!callbackMessageId) return;

  // Telegram-only: WhatsApp interactive buttons expire on their own and have
  // no equivalent edit call.
  if (!threadInfo || threadInfo.channel_type !== "telegram") return;

  const chatId = threadInfo.external_id;
  if (!chatId) return;

  if (!botToken) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: callbackMessageId, reply_markup: { inline_keyboard: [] } }),
    });
    if (!res.ok) {
      console.error("funnel-graph: editMessageReplyMarkup failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("funnel-graph: editMessageReplyMarkup threw", err);
  }
}

async function callTelegramApi(botToken: string, method: string, body: Record<string, unknown>): Promise<TelegramSendResult> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as TelegramApiResponse;

  if (!res.ok || !data.ok) {
    console.error(`funnel-graph: ${method} failed`, data);
    return { ok: false, errorCode: data.error_code };
  }
  return { ok: true };
}

async function sendTelegramAttachment(
  botToken: string,
  chatId: string,
  attachment: MessageAttachment,
  formattedText: string,
  replyMarkup: ReplyMarkup,
): Promise<TelegramSendResult> {
  if (attachment.type === "poll") {
    // MVP: the builder only collects one text field for polls (used as the
    // question) — real answer-option editing is a later step.
    return callTelegramApi(botToken, "sendPoll", {
      chat_id: chatId,
      question: attachment.url || "Опитування",
      options: ["👍", "👎"],
      reply_markup: replyMarkup,
    });
  }

  const spec = ATTACHMENT_METHODS[attachment.type];
  const body: Record<string, unknown> = {
    chat_id: chatId,
    [spec.field]: attachment.url,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (formattedText && spec.supportsCaption) {
    body.caption = formattedText;
    body.parse_mode = "MarkdownV2";
  }
  return callTelegramApi(botToken, spec.method, body);
}

// Telegram has no single call for "several different attachment types plus
// buttons" (sendMediaGroup accepts multiple photo/video/audio/document items
// but neither supports reply_markup nor mixes in video_note/voice/poll) — so
// several attachments go out as individual sends, in the block list's order.
// The caption goes on the first item if that type supports one (otherwise a
// leading plain text message carries it instead, so text is never silently
// dropped); the buttons go on the last item, after all content has arrived.
async function sendTelegramAttachmentSequence(
  botToken: string,
  chatId: string,
  attachments: MessageAttachment[],
  formattedText: string,
  replyMarkup: ReplyMarkup,
): Promise<TelegramSendResult> {
  const firstSupportsCaption = attachments[0].type !== "poll" && ATTACHMENT_METHODS[attachments[0].type]?.supportsCaption;

  if (formattedText && !firstSupportsCaption) {
    const result = await callTelegramApi(botToken, "sendMessage", { chat_id: chatId, text: formattedText, parse_mode: "MarkdownV2" });
    if (!result.ok) return result;
  }

  for (let i = 0; i < attachments.length; i++) {
    const isFirst = i === 0;
    const isLast = i === attachments.length - 1;
    const caption = isFirst && firstSupportsCaption ? formattedText : "";
    const result = await sendTelegramAttachment(botToken, chatId, attachments[i], caption, isLast ? replyMarkup : undefined);
    if (!result.ok) return result;
  }

  return { ok: true };
}
