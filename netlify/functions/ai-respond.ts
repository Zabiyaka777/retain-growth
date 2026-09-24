import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { processGraphState, resolveNextNode } from "./_shared/funnel-graph";
import { startTypingIndicator } from "./_shared/typing-indicator";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const MAX_TOKENS = 1024;
// Replayed history cap. Every turn re-sends the whole window, so this bounds
// both latency and per-turn token spend on long-running conversations.
const HISTORY_LIMIT = 40;

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

// Test-only override, mirrored in ai-generate-tasks.ts.
//
// Deliberately NOT named OPENROUTER_BASE_URL: Netlify's AI Gateway injects
// that name (alongside OPENAI_BASE_URL / ANTHROPIC_BASE_URL) into every
// function at runtime, pointing at <site>/.netlify/ai. Reading it silently
// redirected every call to the gateway, which answers 401 with an empty body.
// Only localhost values are honoured, so no injected or stray value can ever
// point real API traffic somewhere else again.
function resolveOpenRouterBaseUrl(): string {
  const override = process.env.RG_OPENROUTER_BASE_URL;
  if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(override)) return override;
  return "https://openrouter.ai/api/v1";
}

const OPENROUTER_BASE_URL = resolveOpenRouterBaseUrl();

// How many times we'll let the model call tools before insisting on a final
// text reply. Guards against a model that loops on mark_task_done forever.
const MAX_TOOL_ROUNDS = 5;

// funnel_edges.from_button_id values for the ai node's three outputs. These
// double as the React Flow handle ids in FunnelBuilder.tsx.
const EXIT_TASKS_COMPLETED = "tasks_completed";
const EXIT_AI_ERROR = "ai_error";
const EXIT_MANAGER_NEEDED = "manager_needed";

interface AiTask {
  id: string;
  description: string;
}

interface AiNodeConfig {
  context?: string;
  rules?: string;
  model?: string;
  tasks?: AiTask[];
  min_attempts_before_error?: number;
  // Pre-split shape. Nothing in the DB uses it any more, but reading it costs
  // nothing and keeps an older saved node answering instead of going mute.
  system_prompt?: string;
  // Advanced setting, default off (existing nodes keep today's behavior
  // unchanged). When on, remember_fact writes to node_lead_memory scoped to
  // this exact funnel_node_id instead of the global lead_memory table, and
  // the prompt is built from that node-scoped memory instead of the global
  // one — the two systems are deliberately not merged (see ai-respond.ts).
  memory_enabled?: boolean;
}

interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

// The chat-completions message list carries more than plain turns once tools
// are in play: assistant messages can hold tool_calls, and tool results come
// back as their own role.
type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface AiProgress {
  completed_task_ids?: string[];
  // How many times report_error fired and was deflected back into the
  // conversation instead of escalating.
  failed_attempts?: number;
}

// How many clarification rounds before report_error actually escalates.
const DEFAULT_MIN_ATTEMPTS_BEFORE_ERROR = 2;

// Hard rules appended to every AI node's prompt. Added after a live lead saw
// the model answer its own question in their voice ("Здравствуйте! Мне 35
// лет.") when they replied with an implausible age, then treat that invented
// number as an established fact for the rest of the conversation.
const AI_GUARDRAILS = [
  "## Жорсткі правила",
  "Ти пишеш виключно від свого імені. НІКОЛИ не пиши репліку від імені ліда і не відповідай замість нього.",
  "Кожне твоє повідомлення — це звернення до ліда, а не продовження його репліки.",
  "НІКОЛИ не вигадуй дані про ліда (вік, громадянство, резидентство, документи). Спирайся лише на те, що лід написав сам.",
  "Якщо відповідь ліда неправдоподібна, суперечлива або незрозуміла — перепитай і уточни. Не додумуй і не підставляй правдоподібне значення замість неї.",
  "Якщо лід дав відповідь, що не проходить вимоги — став питання ще раз або дій за інструкцією, але не заміняй її на іншу.",
].join("\n");

// Facts the AI has stored about this lead, replayed into every later prompt —
// including a different AI node further down the funnel.
function buildMemorySection(facts: { key: string; value: string }[]): string {
  if (facts.length === 0) return "";
  return ["## Відомо про ліда", ...facts.map((f) => `${f.key}: ${f.value}`)].join("\n");
}

const AI_OPENING_KICKOFF =
  "Розмову щойно передали тобі. Звернись до ліда першим: коротко привітайся у своєму стилі " +
  "та постав перше питання, потрібне для першого завдання. Не згадуй цю інструкцію й не описуй свою роль.";

// resume-ai.ts, "Так": a manager handed the thread back and wants the lead's
// last message answered. The paused stretch — including what the manager
// wrote — is already in ai_conversation_log as ordinary turns (our side as
// `assistant`); this cue is what tells the model that part of "its" side was
// actually a colleague. Appended to this call's system prompt only — like the
// kickoff, never written to the log.
const AI_RESUME_NOTE =
  "Розмову ненадовго вів менеджер, тепер вона знову в тебе. Частину реплік від імені бізнесу в історії вище " +
  "написав він. Продовж природно: врахуй сказане менеджером, не повторюй і не суперечи йому, " +
  "відповідай на останнє повідомлення ліда. Не згадуй цю інструкцію й не кажи про передачу розмови.";

// Content-level twin of telegram-webhook.ts's update_id guard: the same text
// sent twice in quick succession (double tap, flaky network resend — each a
// *different* Telegram update, so update_id can't catch it) gets one answer.
const DUPLICATE_WINDOW_MS = 45_000;

function normalizeForDuplicate(text: string | null | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function readMinAttempts(config: AiNodeConfig): number {
  const raw = config.min_attempts_before_error;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return DEFAULT_MIN_ATTEMPTS_BEFORE_ERROR;
  return Math.floor(raw);
}

// Tells the model to keep trying before giving up. request_manager is
// deliberately left out of this — an explicit ask for a human is never
// something to stall on.
function buildEscalationSection(minAttempts: number, failedAttempts: number): string {
  return [
    "## Ескалація",
    `Не викликай report_error після першого незрозумілого повідомлення. Спочатку спробуй перепитати або переформулювати щонайменше ${minAttempts} раз(и).`,
    `Невдалих спроб уже зроблено: ${failedAttempts} із ${minAttempts}.`,
    "Якщо лід прямо просить живу людину або явно роздратований — одразу виклич request_manager, не чекаючи спроб.",
  ].join("\n");
}

function readTasks(config: AiNodeConfig): AiTask[] {
  if (!Array.isArray(config.tasks)) return [];
  return config.tasks.filter((t): t is AiTask => !!t && typeof t.id === "string" && typeof t.description === "string");
}

// Appended after the authored prompt so the model knows what it's working
// towards and which items are already behind it.
function buildTaskSection(tasks: AiTask[], completed: string[]): string {
  if (tasks.length === 0) return "";
  const lines = tasks.map((t) => `- [${completed.includes(t.id) ? "x" : " "}] (${t.id}) ${t.description}`);
  const allDone = tasks.every((t) => completed.includes(t.id));
  return [
    "## Завдання",
    "Веди розмову природно і, щойно завдання виконано, познач його через mark_task_done(task_id).",
    ...lines,
    allDone
      ? "Усі завдання виконані — попрощайся і виклич advance_funnel(), щоб передати ліда далі по воронці."
      : "Не викликай advance_funnel, доки всі завдання не позначені виконаними.",
  ].join("\n");
}

function buildTools(tasks: AiTask[], allDone: boolean) {
  // The two escalation tools are about getting unstuck, not about progress,
  // so they're offered even on a node with no task list at all.
  const tools: unknown[] = [
    {
      type: "function",
      function: {
        name: "remember_fact",
        description:
          "Зберегти факт про ліда (вік, місто, резидентство, побажання тощо), щоб памʼятати його в подальшій розмові та на інших кроках воронки. Викликай одразу, щойно лід повідомив щось про себе.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Коротка назва факту, напр. 'вік' або 'резидентство'" },
            value: { type: "string", description: "Значення саме так, як його повідомив лід" },
          },
          required: ["key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "report_error",
        description:
          "Викликай, коли не можеш продовжити діалог: запит поза наданим контекстом, лід повторно відповідає нерелевантно, або інструкція не покриває ситуацію.",
        parameters: {
          type: "object",
          properties: { reason: { type: "string", description: "Коротко: чому не можеш продовжити" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "request_manager",
        description:
          "Викликай, коли лід прямо просить живу людину, або видно фрустрацію чи складний випадок поза межами твоєї інструкції.",
        parameters: {
          type: "object",
          properties: { reason: { type: "string", description: "Коротко: чому потрібен менеджер" } },
        },
      },
    },
  ];

  if (tasks.length > 0) {
    tools.push({
      type: "function",
      function: {
        name: "mark_task_done",
        description: "Позначити одне завдання виконаним. Викликай одразу, щойно завдання справді виконано.",
        parameters: {
          type: "object",
          properties: { task_id: { type: "string", enum: tasks.map((t) => t.id) } },
          required: ["task_id"],
        },
      },
    });

    // Only offered once everything is done, so the model can't skip the list.
    if (allDone) {
      tools.push({
        type: "function",
        function: {
          name: "advance_funnel",
          description: "Завершити AI-етап і передати ліда до наступного кроку воронки. Лише коли всі завдання виконані.",
          parameters: { type: "object", properties: {} },
        },
      });
    }
  }

  return tools;
}

// The two authored fields become one system prompt, each under its own
// heading so the model can tell background apart from constraints.
// Exported for testing. Netlify only treats the `handler` export as the
// endpoint, so extra named exports don't create a second function.
export function buildSystemPrompt(config: AiNodeConfig): string {
  const context = (config.context ?? "").trim();
  const rules = (config.rules ?? "").trim();

  const sections: string[] = [];
  if (context) sections.push(`## Контекст\n${context}`);
  if (rules) sections.push(`## Правила\n${rules}`);
  if (sections.length > 0) return sections.join("\n\n");

  return (config.system_prompt ?? "").trim();
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Called only by telegram-webhook.ts, never by a browser. Unlike
// funnel-advance.ts (the other internal-call endpoint), a request here spends
// the org's Anthropic credits, so it's gated on a secret both functions
// already share via env rather than left open.
function isInternalCall(event: Parameters<Handler>[0]): boolean {
  const provided = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  return !!provided && provided === serviceRoleKey;
}

// OpenRouter speaks the OpenAI chat-completions format, where the system
// prompt is just the first message instead of a separate field. Returns the
// whole assistant message, since with tools enabled the useful part may be
// tool_calls rather than content.
async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "X-Title": "Retain Growth",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages,
      ...(tools ? { tools } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const message = data.choices?.[0]?.message;
  return {
    content: (message?.content ?? "").trim(),
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
  };
}

// Leaves ai_active and hands the state back to the normal graph walk, using
// the ai node's own outgoing edge (from_button_id null, exactly like a
// message node with no buttons).
// Exported for the same reason parseGeneratedTasks and describeOpenRouterError
// are: the branch it picks is worth exercising directly rather than hoping a
// live model happens to call the right tool.
export async function advanceFromAiNode(
  supabase: SupabaseClient,
  state: { id: string; funnel_node_id: string | null; funnel_id: string },
  orgId: string,
  exit: string,
): Promise<void> {
  const threadState = await supabase.from("funnel_states").select("thread_id").eq("id", state.id).maybeSingle();
  const threadId = threadState.data?.thread_id as string | undefined;

  let nextNodeId: string | null = null;
  // Set when the escalation exit was unwired and the completion edge was used
  // instead — the lead moved on, but the funnel is still missing a branch and
  // the event below has to say so.
  let usedFallback = false;

  if (state.funnel_node_id) {
    nextNodeId = await resolveNextNode(supabase, state.funnel_node_id, exit);
    // The completion exit predates named handles and was stored with a null
    // from_button_id — keep those edges working.
    if (!nextNodeId && exit === EXIT_TASKS_COMPLETED) {
      nextNodeId = await resolveNextNode(supabase, state.funnel_node_id, null);
    }

    // An unwired escalation exit used to end the funnel where it stood, which
    // silently dropped the lead — most visibly when they asked for a human
    // right after finishing every task, so the conversion node never ran.
    // Falling through to wherever "Завдання виконані" leads keeps them moving.
    // Only for the escalation exits: tasks_completed has nowhere else to go.
    if (!nextNodeId && exit !== EXIT_TASKS_COMPLETED) {
      nextNodeId =
        (await resolveNextNode(supabase, state.funnel_node_id, EXIT_TASKS_COMPLETED)) ??
        (await resolveNextNode(supabase, state.funnel_node_id, null));
      if (nextNodeId) usedFallback = true;
    }
  }

  // Logged whether or not the fallback saved the walk: the branch is still
  // missing from the graph, and /admin/security is where that gets noticed.
  // Without this, a funnel routed by fallback would look exactly like one
  // wired correctly.
  if (!nextNodeId || usedFallback) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "ai_exit_not_connected",
      level: "warn",
      payload: {
        exit,
        thread_id: threadId ?? null,
        funnel_state_id: state.id,
        funnel_node_id: state.funnel_node_id,
        fallback: usedFallback ? EXIT_TASKS_COMPLETED : null,
        fallback_node_id: usedFallback ? nextNodeId : null,
      },
    });
    if (eventError) console.error("ai-respond: events insert failed", eventError);
  }

  if (!nextNodeId) {
    // Nothing wired at all — there is genuinely nowhere to send the lead, so
    // the funnel ends here rather than leaving them stuck in AI mode.
    await supabase.from("funnel_states").update({ status: "completed" }).eq("id", state.id);
    return;
  }

  // Back to 'active' before walking, otherwise processGraphState would leave
  // the state parked as ai_active and the cron would never pick it up again.
  await supabase
    .from("funnel_states")
    .update({ status: "active", funnel_node_id: nextNodeId, waiting_until: new Date().toISOString() })
    .eq("id", state.id);

  if (!threadId) {
    console.error("ai-respond: thread_id missing for state, leaving advance to cron", state.id);
    return;
  }

  try {
    await processGraphState(
      supabase,
      { id: state.id, thread_id: threadId, org_id: orgId, funnel_id: state.funnel_id, funnel_node_id: nextNodeId },
      null,
    );
  } catch (err) {
    // Already persisted as active-and-due above, so the cron retries it.
    console.error("ai-respond: processGraphState after advance failed", state.id, err);
  }
}

// A voice note carries no text of its own — transcribe-voice.ts fills
// messages.transcript for it, and that transcript is what the model should
// read. Resolved here rather than in the webhook so every caller (a retry, a
// manual re-run) gets the same behaviour from the same place.
//
// telegram-webhook.ts already awaits the transcription before invoking us, so
// in practice the first read succeeds; the short retry only covers a caller
// that didn't wait, and is deliberately brief because this runs inside the
// function's own request budget.
const TRANSCRIPT_RETRIES = 3;
const TRANSCRIPT_RETRY_MS = 1000;

async function resolveVoiceTranscript(supabase: SupabaseClient, threadId: string): Promise<string | null> {
  const { data: message, error } = await supabase
    .from("messages")
    .select("id, meta")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !message) {
    if (error) console.error("ai-respond: latest inbound lookup failed", error);
    return null;
  }

  const attachments = (message.meta as { attachments?: { type?: string }[] } | null)?.attachments;
  const isVoice = Array.isArray(attachments) && attachments.some((a) => a?.type === "voice" || a?.type === "audio");
  if (!isVoice) return null;

  for (let attempt = 0; attempt < TRANSCRIPT_RETRIES; attempt++) {
    const { data: row } = await supabase.from("messages").select("transcript").eq("id", message.id).maybeSingle();
    const transcript = (row?.transcript as string | null | undefined)?.trim();
    if (transcript) return transcript;
    if (attempt < TRANSCRIPT_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_RETRY_MS));
    }
  }

  return null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  if (!isInternalCall(event)) {
    console.error("ai-respond: rejected non-internal call");
    return jsonResponse(403, { error: "Forbidden" });
  }

  let threadId: string | undefined;
  let userText: string | undefined;
  // Opening turn: the graph just handed the thread over, so there's no inbound
  // message to answer — the model speaks first instead of waiting in silence.
  let opening = false;
  // Which funnel_states row this call concerns. A thread can carry more than
  // one 'ai_active' row at once now (a lead can be enrolled in several
  // funnels — see toggle-funnel.ts), so every caller that already knows which
  // one it's dealing with (triggerAiOpening, the webhooks' text-message
  // hand-off) passes it explicitly instead of leaving this function to guess
  // by thread_id alone.
  let stateId: string | undefined;
  // WhatsApp only — the wamid of the inbound message, needed to mark it
  // read + show the typing indicator via Cloud API. Telegram/FBM don't need
  // an equivalent: their typing signal targets the chat, not a message id.
  let waMessageId: string | undefined;
  // The messages row this call answers (telegram-webhook.ts). Pins down which
  // of two identical messages is "this" one for the duplicate check below.
  let inboundMessageId: string | undefined;
  // resume-ai.ts: answer the thread as it stands — the lead's last message is
  // already in the history, so there is no userText to log.
  let resume = false;
  try {
    const body = JSON.parse(event.body || "{}");
    threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    userText = typeof body.userText === "string" ? body.userText : undefined;
    opening = body.opening === true;
    stateId = typeof body.stateId === "string" ? body.stateId : undefined;
    waMessageId = typeof body.waMessageId === "string" ? body.waMessageId : undefined;
    inboundMessageId = typeof body.inboundMessageId === "string" ? body.inboundMessageId : undefined;
    resume = body.resume === true;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  // userText may legitimately be empty: a voice note has no text until its
  // transcript is resolved below.
  if (!threadId) {
    return jsonResponse(400, { error: "threadId обов'язковий" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: thread, error: threadError } = await supabase
    .from("threads")
    .select("id, org_id, channel_type, lead_id, leads ( external_id, status )")
    .eq("id", threadId)
    .maybeSingle();

  if (threadError || !thread) {
    console.error("ai-respond: thread not found", threadId, threadError);
    return jsonResponse(404, { error: "Тред не знайдено" });
  }

  const orgId = thread.org_id as string;
  const lead = (thread as unknown as { leads: { external_id: string; status: string } | null }).leads;
  const chatId = lead?.external_id;
  if (!chatId) {
    console.error("ai-respond: lead not found for thread", threadId);
    return jsonResponse(404, { error: "Ліда не знайдено" });
  }

  // A blocked or archived lead's thread stays fully readable (messages
  // already recorded by telegram-webhook.ts before this call) — only the
  // automated reply is withheld. No funnel_states/tag/message side effect
  // happens below this.
  if (lead?.status === "blocked" || lead?.status === "archived") {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "blocked_lead_ignored",
      level: "info",
      payload: { source: "ai-respond", thread_id: threadId, lead_id: thread.lead_id, lead_status: lead.status },
    });
    if (eventError) console.error("ai-respond: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: `lead_${lead.status}` });
  }

  // The parked ai-node state is what supplies the prompt — if it's gone (e.g.
  // "Відкрити чат" handed the thread to a human), there's nothing to answer with.
  //
  // With a stateId, this is an exact, unambiguous lookup by primary key — the
  // caller already resolved which funnel this call concerns. Without one
  // (kept only for robustness; every current caller passes stateId), fall
  // back to thread_id + status, picking the most recently entered row if more
  // than one matches rather than erroring out on the ambiguity.
  let state: { id: string; funnel_node_id: string | null; funnel_id: string; ai_progress: unknown } | null = null;
  let stateError: unknown = null;

  if (stateId) {
    const res = await supabase
      .from("funnel_states")
      .select("id, funnel_node_id, funnel_id, ai_progress")
      .eq("id", stateId)
      .eq("thread_id", threadId)
      .eq("status", "ai_active")
      .maybeSingle();
    state = res.data;
    stateError = res.error;
  } else {
    const res = await supabase
      .from("funnel_states")
      .select("id, funnel_node_id, funnel_id, ai_progress")
      .eq("thread_id", threadId)
      .eq("status", "ai_active")
      .order("created_at", { ascending: false });
    stateError = res.error;
    state = res.data?.[0] ?? null;
  }

  if (stateError || !state?.funnel_node_id) {
    console.error("ai-respond: no ai_active state for thread", threadId, stateError);
    return jsonResponse(409, { error: "Тред не в AI-режимі" });
  }

  // Visibility, independent of which branch above resolved `state`: a thread
  // with more than one concurrent 'ai_active' row means this lead is mid-
  // conversation with the AI in more than one funnel at the same time. Not
  // fatal any more (the lookup above is now exact), but easy to miss in day-
  // to-day operation and worth a signal in /admin/security regardless.
  const { data: allActiveStates, error: allActiveError } = await supabase
    .from("funnel_states")
    .select("id, funnel_id, funnel_node_id")
    .eq("thread_id", threadId)
    .eq("status", "ai_active");

  if (allActiveError) {
    console.error("ai-respond: ai_active count lookup failed", allActiveError);
  } else if ((allActiveStates ?? []).length > 1) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "multiple_ai_active_states",
      level: "warn",
      payload: {
        thread_id: threadId,
        resolved_state_id: state.id,
        states: (allActiveStates ?? []).map((s) => ({ id: s.id, funnel_id: s.funnel_id, funnel_node_id: s.funnel_node_id })),
      },
    });
    if (eventError) console.error("ai-respond: events insert failed", eventError);
  }

  // Same text from the lead within DUPLICATE_WINDOW_MS of an earlier inbound
  // message → the earlier one's call answers, this one stays silent. Only
  // messages strictly before this one count (ties broken by id), so of two
  // identical messages exactly one is ever the "earlier" — never both skip.
  // Empty bodies (voice notes, media) are never treated as duplicates.
  if (!opening && !resume && inboundMessageId) {
    const { data: current } = await supabase
      .from("messages")
      .select("id, body, created_at")
      .eq("id", inboundMessageId)
      .eq("thread_id", threadId)
      .maybeSingle();
    const currentText = normalizeForDuplicate(current?.body as string | null);
    if (current && currentText) {
      const since = new Date(Date.parse(current.created_at as string) - DUPLICATE_WINDOW_MS).toISOString();
      const { data: earlier, error: earlierError } = await supabase
        .from("messages")
        .select("id, body")
        .eq("thread_id", threadId)
        .eq("direction", "inbound")
        .neq("id", current.id)
        .gte("created_at", since)
        .or(`created_at.lt.${current.created_at},and(created_at.eq.${current.created_at},id.lt.${current.id})`);
      if (earlierError) console.error("ai-respond: duplicate lookup failed", earlierError);
      const duplicateOf = (earlier ?? []).find((m) => normalizeForDuplicate(m.body as string | null) === currentText);
      if (duplicateOf) {
        const { error: eventError } = await supabase.from("events").insert({
          org_id: orgId,
          type: "ai_duplicate_inbound_skipped",
          level: "info",
          payload: { thread_id: threadId, message_id: current.id, duplicate_of: duplicateOf.id },
        });
        if (eventError) console.error("ai-respond: events insert failed", eventError);
        return jsonResponse(200, { ok: false, reason: "duplicate_inbound" });
      }
    }
  }

  const { data: node, error: nodeError } = await supabase
    .from("funnel_nodes")
    .select("config")
    .eq("id", state.funnel_node_id)
    .maybeSingle();

  if (nodeError || !node) {
    console.error("ai-respond: ai node not found", state.funnel_node_id, nodeError);
    return jsonResponse(404, { error: "AI-вузол не знайдено" });
  }

  const config = (node.config ?? {}) as AiNodeConfig;
  const model = config.model?.trim() || DEFAULT_MODEL;
  const tasks = readTasks(config);
  const progress = (state.ai_progress ?? {}) as AiProgress;
  // Only ids still present in the node's config count — a task deleted from
  // the node shouldn't keep the list looking complete.
  const completedTaskIds = (progress.completed_task_ids ?? []).filter((id) => tasks.some((t) => t.id === id));
  const minAttempts = readMinAttempts(config);
  const failedAttempts = typeof progress.failed_attempts === "number" ? progress.failed_attempts : 0;

  const leadId = thread.lead_id as string;
  const memoryEnabled = config.memory_enabled === true;

  // Two separate systems, never merged for one prompt: with memory_enabled
  // off (default, unchanged behavior), lead_memory is global and follows the
  // lead across the whole funnel including a different AI node. With it on,
  // this node reads only its own node_lead_memory — a fact learned here never
  // shows up on another node's prompt, in this funnel or a different one.
  const { data: memoryRows, error: memoryError } = memoryEnabled
    ? await supabase
        .from("node_lead_memory")
        .select("key, value")
        .eq("funnel_node_id", state.funnel_node_id as string)
        .eq("lead_id", leadId)
        .order("updated_at", { ascending: true })
    : await supabase
        .from("lead_memory")
        .select("key, value")
        .eq("lead_id", leadId)
        .order("updated_at", { ascending: true });

  if (memoryError) console.error("ai-respond: lead memory lookup failed", memoryError);

  const taskSection = buildTaskSection(tasks, completedTaskIds);
  const escalationSection = buildEscalationSection(minAttempts, failedAttempts);
  const memorySection = buildMemorySection((memoryRows ?? []) as { key: string; value: string }[]);
  const basePrompt = buildSystemPrompt(config);
  // Guardrails last: closest to the conversation, hardest to drift away from.
  // The resume cue goes into the one leading system message rather than a
  // trailing one: several providers behind OpenRouter only accept `system`
  // at the start of the conversation.
  const systemPrompt = [basePrompt, memorySection, taskSection, escalationSection, AI_GUARDRAILS, resume ? AI_RESUME_NOTE : ""]
    .filter(Boolean)
    .join("\n\n");

  const { data: credential, error: credentialError } = await supabase
    .from("ai_credentials")
    .select("api_key_secret_id")
    .eq("org_id", orgId)
    .maybeSingle();

  // No key: record it and stop. The lead gets nothing rather than a confusing
  // half-answer, and the thread stays in AI mode so it recovers on its own
  // once a key is added.
  if (credentialError || !credential) {
    console.error("ai-respond: no ai credential for org", orgId, credentialError);
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "ai_credential_missing",
      level: "error",
      payload: { thread_id: threadId, funnel_state_id: state.id, funnel_node_id: state.funnel_node_id },
    });
    if (eventError) console.error("ai-respond: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "ai_credential_missing" });
  }

  const { data: apiKey, error: keyError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.api_key_secret_id,
  });

  if (keyError || !apiKey) {
    console.error("ai-respond: failed to decrypt api key", keyError);
    return jsonResponse(500, { error: "Не вдалося прочитати AI-ключ" });
  }

  // Voice note: swap in its transcript and carry on down the ordinary text
  // path — logged to ai_conversation_log, sent to the model and answered
  // exactly like a typed message.
  if (!opening && !resume && !userText) {
    const transcript = await resolveVoiceTranscript(supabase, threadId);
    if (transcript) {
      userText = transcript;
    } else {
      // Nothing to answer. Staying silent beats replying to an empty string,
      // which is what produced a generic non-answer before this existed.
      const { error: eventError } = await supabase.from("events").insert({
        org_id: orgId,
        type: "ai_no_input",
        level: "warn",
        payload: { thread_id: threadId, reason: "empty_text_no_transcript" },
      });
      if (eventError) console.error("ai-respond: events insert failed", eventError);
      return jsonResponse(200, { ok: false, reason: "no_input" });
    }
  }

  // Log the lead's turn first so the history read below already contains it —
  // one source of truth for what was actually sent to the model. An opening
  // turn has no lead message to log, and neither has a resume (resume-ai.ts
  // already copied the lead's messages in).
  if (!opening && !resume) {
    const { error: userLogError } = await supabase.from("ai_conversation_log").insert({
      org_id: orgId,
      thread_id: threadId,
      funnel_state_id: state.id,
      role: "user",
      content: userText,
    });
    if (userLogError) console.error("ai-respond: user turn log insert failed", userLogError);
  }

  const { data: history, error: historyError } = await supabase
    .from("ai_conversation_log")
    .select("role, content, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (historyError) {
    console.error("ai-respond: history lookup failed", historyError);
    return jsonResponse(500, { error: "Не вдалося прочитати історію" });
  }

  // Newest-first above (so the cap keeps the most recent turns), flipped back
  // to chronological order for the API.
  const messages: ChatMessage[] = (history ?? [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));

  // Kick-off instruction for the opening turn. Deliberately NOT written to
  // ai_conversation_log — it's an internal cue, not part of the transcript the
  // manager or the model should see replayed on later turns.
  if (opening) {
    messages.push({ role: "user", content: AI_OPENING_KICKOFF });
  }

  if (systemPrompt) messages.unshift({ role: "system", content: systemPrompt });

  // Tool round-trips live only inside this invocation — ai_conversation_log
  // stays the human-readable transcript, so its user/assistant shape is
  // untouched. Only the effects (ai_progress, the advance) are persisted.
  let replyText = "";
  // Which of the ai node's outputs the model asked to leave through, if any.
  let exitRequested: string | null = null;
  const newlyCompleted = new Set(completedTaskIds);
  let failedAttemptsNow = failedAttempts;

  // "Typing…"/read signal for exactly the span the lead is actually waiting
  // on the model — psychological only, doesn't change how long this takes.
  const stopTyping = await startTypingIndicator(supabase, {
    channel: thread.channel_type as string,
    orgId,
    chatId: chatId ? String(chatId) : null,
    waMessageId,
  });

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const allDone = tasks.length > 0 && tasks.every((t) => newlyCompleted.has(t.id));
      const result = await callOpenRouter(apiKey as string, model, messages, buildTools(tasks, allDone));

      if (result.toolCalls.length === 0) {
        // Only overwrite when this round actually said something. A model
        // that greeted the lead *and* called mark_task_done in one round
        // (round 0) has nothing left to add in the next one and answers with
        // an empty string — assigning that unconditionally threw away the
        // greeting it had already written, and the lead heard nothing.
        if (result.content) replyText = result.content;
        break;
      }

      messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });

      for (const call of result.toolCalls) {
        let outcome = "ok";
        if (call.function?.name === "mark_task_done") {
          let taskId: string | undefined;
          try {
            taskId = JSON.parse(call.function.arguments || "{}").task_id;
          } catch {
            taskId = undefined;
          }
          if (taskId && tasks.some((t) => t.id === taskId)) {
            newlyCompleted.add(taskId);
            outcome = `Завдання ${taskId} позначено виконаним.`;
          } else {
            outcome = `Невідоме завдання: ${taskId ?? "—"}`;
          }
        } else if (call.function?.name === "advance_funnel") {
          if (tasks.length > 0 && tasks.every((t) => newlyCompleted.has(t.id))) {
            exitRequested = EXIT_TASKS_COMPLETED;
            outcome = "Воронка рухається далі.";
          } else {
            outcome = "Ще не всі завдання виконані — advance_funnel недоступний.";
          }
        } else if (call.function?.name === "remember_fact") {
          let key: string | undefined;
          let value: string | undefined;
          try {
            const args = JSON.parse(call.function.arguments || "{}");
            key = typeof args.key === "string" ? args.key.trim() : undefined;
            value = typeof args.value === "string" ? args.value.trim() : undefined;
          } catch {
            key = undefined;
          }
          if (key && value) {
            // Whichever system is reading the prompt (above) is the one this
            // writes to — never both, so a node with memory_enabled on never
            // silently also feeds the global lead_memory a lead won't see
            // replayed here anyway.
            const { error: memErr } = memoryEnabled
              ? await supabase.from("node_lead_memory").upsert(
                  { org_id: orgId, funnel_node_id: state.funnel_node_id as string, lead_id: leadId, key, value, updated_at: new Date().toISOString() },
                  { onConflict: "funnel_node_id,lead_id,key" },
                )
              : await supabase.from("lead_memory").upsert(
                  { org_id: orgId, lead_id: leadId, key, value, updated_at: new Date().toISOString() },
                  { onConflict: "lead_id,key" },
                );
            if (memErr) {
              console.error("ai-respond: lead memory upsert failed", memErr);
              outcome = "Не вдалося зберегти факт.";
            } else {
              outcome = `Запамʼятав: ${key} — ${value}.`;
            }
          } else {
            outcome = "Потрібні і key, і value.";
          }
        } else if (call.function?.name === "report_error") {
          // Deflect the first N-1 attempts back into the conversation: the
          // model is told to rephrase and keep going, and only the attempt
          // that reaches the threshold actually leaves the node.
          failedAttemptsNow += 1;
          if (failedAttemptsNow >= minAttempts) {
            exitRequested = EXIT_AI_ERROR;
            outcome = "Ліміт спроб вичерпано, передаю за гілкою «Помилка AI Агента».";
          } else {
            outcome =
              `Ще рано здаватися: це спроба ${failedAttemptsNow} із ${minAttempts}. ` +
              "Не виходь з діалогу — переформулюй питання простіше, задай уточнювальне питання " +
              "або запропонуй варіанти відповіді, і надішли лідy звичайну текстову відповідь.";
          }
        } else if (call.function?.name === "request_manager") {
          exitRequested = EXIT_MANAGER_NEEDED;
          outcome = "Передаю за гілкою «Потрібен менеджер».";
        } else {
          outcome = `Невідомий інструмент: ${call.function?.name ?? "—"}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome });
      }

      // Keep the reply from the round that also carried tool calls, so a
      // model that says goodbye and advances in one turn isn't left silent.
      if (result.content) replyText = result.content;
    }
  } catch (err) {
    stopTyping();
    console.error("ai-respond: OpenRouter call failed", err);
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "ai_provider_error",
      level: "error",
      payload: { model, thread_id: threadId, message: err instanceof Error ? err.message : String(err) },
    });
    if (eventError) console.error("ai-respond: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "ai_provider_error" });
  }
  stopTyping();

  // Persist progress before anything can fail below — a marked task should
  // survive even if the send does not.
  const completedNow = [...newlyCompleted];
  const tasksChanged = completedNow.length !== completedTaskIds.length;
  const attemptsChanged = failedAttemptsNow !== failedAttempts;
  // Written as one object, so bumping the attempt counter can't drop the
  // completed-task list (or vice versa).
  if (tasksChanged || attemptsChanged) {
    const { error: progressError } = await supabase
      .from("funnel_states")
      .update({ ai_progress: { completed_task_ids: completedNow, failed_attempts: failedAttemptsNow } })
      .eq("id", state.id);
    if (progressError) console.error("ai-respond: ai_progress update failed", progressError);
  }

  // A tool-only turn leaves the lead staring at silence. That's acceptable
  // when the model is leaving the node (the next node speaks), but nowhere
  // else — and on the opening turn it's the exact dead-end triggerAiOpening
  // exists to prevent: the hand-off message promises an assistant that then
  // never says anything, and since the lead has no reason to write again,
  // ai-respond is never called a second time either.
  //
  // Observed in production: on entry the model called mark_task_done for the
  // greeting task and returned no text, so ai_progress recorded the task and
  // this function returned ok:true without sending a word.
  //
  // One more call with tools withheld, so the model has to answer in words.
  if (!replyText && !exitRequested) {
    try {
      const forced = await callOpenRouter(apiKey as string, model, messages, undefined);
      replyText = forced.content;
    } catch (err) {
      console.error("ai-respond: forced text completion failed", err);
    }
  }

  // A turn that only ran tools is legitimate — don't treat it as an error.
  if (!replyText && (exitRequested || tasksChanged || attemptsChanged)) {
    if (exitRequested) await advanceFromAiNode(supabase, state, orgId, exitRequested);
    return jsonResponse(200, { ok: true, advanced: !!exitRequested, exit: exitRequested, completedTaskIds: completedNow, failedAttempts: failedAttemptsNow });
  }

  if (!replyText) {
    console.error("ai-respond: empty reply from model", model);
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "ai_empty_reply",
      level: "error",
      payload: { model, thread_id: threadId },
    });
    if (eventError) console.error("ai-respond: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "ai_empty_reply" });
  }

  const { data: telegramCredential, error: telegramCredentialError } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", thread.channel_type as string)
    .maybeSingle();

  if (telegramCredentialError || !telegramCredential) {
    console.error("ai-respond: no channel credential for org", orgId, telegramCredentialError);
    return jsonResponse(424, { error: "Канал не підключено" });
  }

  const { data: botToken, error: botTokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: telegramCredential.bot_token_secret_id,
  });

  if (botTokenError || !botToken) {
    console.error("ai-respond: failed to decrypt bot token", botTokenError);
    return jsonResponse(500, { error: "Не вдалося прочитати токен бота" });
  }

  // Plain text, no parse_mode: model output is free-form and any stray
  // MarkdownV2 metacharacter would make Telegram reject the whole message.
  const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: replyText }),
  });

  if (!sendRes.ok) {
    console.error("ai-respond: sendMessage failed", await sendRes.text());
    return jsonResponse(502, { error: "Не вдалося надіслати повідомлення" });
  }

  // Logged only after a confirmed send, so the transcript and the chat UI
  // never show a reply the lead never received.
  const { error: assistantLogError } = await supabase.from("ai_conversation_log").insert({
    org_id: orgId,
    thread_id: threadId,
    funnel_state_id: state.id,
    role: "assistant",
    content: replyText,
  });
  if (assistantLogError) console.error("ai-respond: assistant turn log insert failed", assistantLogError);

  const { error: messageError } = await supabase.from("messages").insert({
    org_id: orgId,
    thread_id: threadId,
    direction: "outbound",
    body: replyText,
    sender: "ai",
  });
  if (messageError) console.error("ai-respond: messages insert failed", messageError);

  // Last: the farewell has already reached the lead, so the next node's own
  // message lands after it rather than racing it.
  if (exitRequested) await advanceFromAiNode(supabase, state, orgId, exitRequested);

  return jsonResponse(200, { ok: true, advanced: !!exitRequested, exit: exitRequested, completedTaskIds: completedNow, failedAttempts: failedAttemptsNow });
};
