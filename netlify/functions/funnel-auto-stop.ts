import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const CLAIM_BATCH_SIZE = 200;
const ABANDONED_AFTER = "21 days";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ClaimedAbandonedState {
  id: string;
  thread_id: string;
  org_id: string;
  funnel_id: string;
  funnel_node_id: string;
  waiting_until: string;
}

// Scheduled (netlify.toml: schedule = "0 3 * * *" — once a day, not urgent
// like the per-minute processors). Stops 'active' graph states whose
// waiting_until is more than ABANDONED_AFTER in the past.
//
// waiting_until, not created_at, is the field that actually moves on every
// real step (checked in _shared/funnel-graph.ts before writing this: a
// message node with a clickable button sets waiting_until to
// now+AWAITING_INPUT_PAUSE_MS every time it's (re-)entered — including a
// lead-gen-link restart — while created_at is only ever set once, at the
// row's first insert, and stays fixed through every later re-entry). So a
// stale waiting_until is the accurate "no real movement in a long time"
// signal; a fresh one — even on a state created long ago — correctly means
// the lead re-engaged recently and must not be touched.
//
// Only changes `status`; never deletes anything — messages, tags, and
// lead_activity_log history are all left exactly as they are. Doesn't
// interact with funnel-processor-v2.ts's own due-state claiming (that only
// ever claims waiting_until <= now(), the opposite end of the same column).
export const handler: Handler = async () => {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_abandoned_funnel_states", {
    p_limit: CLAIM_BATCH_SIZE,
    p_older_than: ABANDONED_AFTER,
  });

  if (claimError) {
    console.error("funnel-auto-stop: claim_abandoned_funnel_states failed", claimError);
    return { statusCode: 500, body: "claim failed" };
  }

  const states = (claimed ?? []) as ClaimedAbandonedState[];
  let logged = 0;

  for (const state of states) {
    try {
      const { data: thread, error: threadError } = await supabase
        .from("threads")
        .select("lead_id")
        .eq("id", state.thread_id)
        .maybeSingle();

      if (threadError || !thread) {
        console.error("funnel-auto-stop: thread lookup failed", state.id, threadError);
        continue;
      }

      const [{ data: funnel }, { data: node }] = await Promise.all([
        supabase.from("funnels").select("name").eq("id", state.funnel_id).maybeSingle(),
        supabase.from("funnel_nodes").select("config").eq("id", state.funnel_node_id).maybeSingle(),
      ]);

      const nodeLabel = (node?.config as { label?: string } | null)?.label ?? null;
      const daysInactive = Math.floor((Date.now() - new Date(state.waiting_until).getTime()) / MS_PER_DAY);

      const { error: logError } = await supabase.from("lead_activity_log").insert({
        org_id: state.org_id,
        lead_id: thread.lead_id,
        actor_type: "system",
        action_type: "funnel_auto_stopped",
        details: {
          funnel_id: state.funnel_id,
          funnel_name: funnel?.name ?? null,
          funnel_node_id: state.funnel_node_id,
          node_label: nodeLabel,
          days_inactive: daysInactive,
        },
      });

      if (logError) console.error("funnel-auto-stop: lead_activity_log insert failed", state.id, logError);
      else logged++;
    } catch (err) {
      console.error("funnel-auto-stop: unhandled error logging state", state.id, err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ stopped: states.length, logged }) };
};
