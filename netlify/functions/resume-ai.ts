import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./_shared/activity-log";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// How much of the paused stretch is carried into the model's history. Same
// order of magnitude as ai-respond.ts's own HISTORY_LIMIT — enough for a
// manager's back-and-forth, without replaying a week-old thread.
const MAX_GAP_MESSAGES = 30;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * While AI was paused the lead and the manager kept talking, but none of it
 * reached ai_conversation_log — that log is only written by ai-respond.ts,
 * and it isn't called for a stopped state. It is, however, the only history
 * the model ever sees, so without this the AI would resume as if the pause
 * never happened and could repeat or contradict what the manager said.
 *
 * Reads every message newer than the log's last entry as log rows, in order
 * and with its own timestamp: the lead's messages as `user`, anything our
 * side sent (manager, funnel) as `assistant` — the model speaks for the
 * business, and so did they. The AI's own messages are skipped: those were
 * logged by ai-respond.ts already. Voice notes contribute their transcript.
 *
 * Only reads — the caller inserts the rows once it has won the stopped →
 * ai_active switch, so two simultaneous resumes can't both copy the stretch.
 * Read *before* that switch, though: once the state is ai_active, a new lead
 * message would get its own log row, move "the log's last entry" past the
 * paused stretch and hide it from this query.
 */
async function readPausedStretch(supabase: SupabaseClient, orgId: string, threadId: string, stateId: string) {
  const { data: last } = await supabase
    .from("ai_conversation_log")
    .select("created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let query = supabase
    .from("messages")
    .select("direction, body, transcript, sender, created_at")
    .eq("thread_id", threadId)
    .or("sender.is.null,sender.neq.ai")
    .order("created_at", { ascending: false })
    .limit(MAX_GAP_MESSAGES);
  if (last?.created_at) query = query.gt("created_at", last.created_at as string);

  const { data: gap, error } = await query;
  if (error) {
    console.error("resume-ai: paused-stretch lookup failed", error);
    return [];
  }

  return (gap ?? [])
    .slice()
    .reverse()
    .map((m) => ({
      org_id: orgId,
      thread_id: threadId,
      funnel_state_id: stateId,
      role: m.direction === "inbound" ? "user" : "assistant",
      content: ((m.body as string | null)?.trim() || (m.transcript as string | null)?.trim() || "") as string,
      created_at: m.created_at as string,
    }))
    .filter((r) => r.content);
}

/**
 * "Увімкнути AI" — the undo of pause-ai.ts. A manager who answered by hand
 * (which stopped the AI) hands the thread back.
 *
 *   reply: true  — the AI also answers the lead's last message now, if the
 *                  lead is the one waiting (their message is the newest in
 *                  the thread). If the manager already had the last word
 *                  there is nothing to answer, and it says so.
 *   reply: false — the AI only picks up from the lead's next message.
 *
 * Either way the paused stretch is copied into the AI's history first (see
 * readPausedStretch). Only states parked on an AI node can come back to
 * 'ai_active' — a funnel stopped on any other node isn't "paused AI", and
 * forcing it to ai_active would leave it stuck where the cron never looks.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let stateId: string | undefined;
  let reply = false;
  try {
    const body = JSON.parse(event.body || "{}");
    stateId = typeof body.stateId === "string" ? body.stateId : undefined;
    reply = body.reply === true;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!stateId) return jsonResponse(400, { error: "stateId обов'язковий" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // org_id from the session, never from the body (CLAUDE.md: org_id scoping).
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  const { data: state } = await supabase
    .from("funnel_states")
    .select("id, thread_id, funnel_id, funnel_node_id, status, funnel_nodes ( type, config ), threads ( lead_id )")
    .eq("id", stateId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!state) return jsonResponse(404, { error: "Стан воронки не знайдено" });

  const node = (state as unknown as { funnel_nodes: { type: string; config: { label?: string } | null } | null }).funnel_nodes;
  const leadId = (state as unknown as { threads: { lead_id: string } | null }).threads?.lead_id ?? null;
  if (state.status !== "stopped") return jsonResponse(409, { error: "AI для цієї воронки вже не зупинено" });
  if (node?.type !== "ai") return jsonResponse(409, { error: "Воронку зупинено не на AI-вузлі — увімкнути AI тут неможливо" });

  const threadId = state.thread_id as string;
  const pausedStretch = await readPausedStretch(supabase, orgId, threadId, state.id as string);

  // Guarded on 'stopped' so two clicks (or two managers) can't both resume
  // and both fire a reply.
  const { data: resumed, error: updateError } = await supabase
    .from("funnel_states")
    .update({ status: "ai_active" })
    .eq("id", state.id)
    .eq("status", "stopped")
    .select("id");
  if (updateError) {
    console.error("resume-ai: update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося увімкнути AI" });
  }
  if (!resumed || resumed.length === 0) return jsonResponse(409, { error: "AI для цієї воронки вже увімкнено" });

  if (pausedStretch.length > 0) {
    const { error: insertError } = await supabase.from("ai_conversation_log").insert(pausedStretch);
    if (insertError) console.error("resume-ai: paused-stretch log insert failed", insertError);
  }

  // Decided before the activity entry so the log says what actually happens,
  // not what was asked: with the manager having the last word there is
  // nothing to answer, even on "Так".
  let skipReason: string | null = null;
  if (reply) {
    const { data: latest } = await supabase
      .from("messages")
      .select("direction")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.direction !== "inbound") skipReason = "no_pending_inbound";
    else if (!process.env.URL) {
      console.error("resume-ai: URL сайту не сконфігуровано, не можу викликати ai-respond");
      skipReason = "no_site_url";
    }
  }
  const replying = reply && !skipReason;

  if (leadId) {
    const { data: funnel } = await supabase.from("funnels").select("name").eq("id", state.funnel_id).maybeSingle();
    await logLeadActivity(supabase, {
      orgId,
      leadId,
      actionType: "ai_resumed_by_manager",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: {
        funnel_name: (funnel?.name as string | undefined) ?? null,
        node_label: node.config?.label?.trim() || "AI",
        replied: replying,
      },
    });
  }

  if (!replying) return jsonResponse(200, { ok: true, replying: false, ...(skipReason ? { reason: skipReason } : {}) });

  const siteUrl = process.env.URL!;
  try {
    // Same background hop telegram-webhook.ts uses, so this answers the
    // manager right away instead of after the model's round trip.
    await fetch(`${siteUrl}/.netlify/functions/ai-respond-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": serviceRoleKey },
      body: JSON.stringify({ threadId, stateId: state.id, resume: true }),
    });
  } catch (err) {
    console.error("resume-ai: ai-respond invoke failed", err);
    return jsonResponse(200, { ok: true, replying: false, reason: "invoke_failed" });
  }
  return jsonResponse(200, { ok: true, replying: true });
};
