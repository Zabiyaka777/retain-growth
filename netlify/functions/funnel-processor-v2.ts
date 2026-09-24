import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { processGraphState, type ClaimedState } from "./_shared/funnel-graph";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const CLAIM_BATCH_SIZE = 20;

// Scheduled (netlify.toml: schedule = "* * * * *") — Netlify only allows this
// to be invoked by its own internal cron trigger, not by direct HTTP calls
// (confirmed: a direct POST here returns 403). That's exactly why immediate
// processing after a callback_query lives in the separate funnel-advance.ts
// instead of being a second code path in this same file.
export const handler: Handler = async () => {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_due_graph_funnel_states", {
    p_limit: CLAIM_BATCH_SIZE,
  });

  if (claimError) {
    console.error("funnel-processor-v2: claim_due_graph_funnel_states failed", claimError);
    return { statusCode: 500, body: "claim failed" };
  }

  const states = (claimed ?? []) as ClaimedState[];

  for (const state of states) {
    try {
      await processGraphState(supabase, state, null);
    } catch (err) {
      console.error("funnel-processor-v2: unhandled error processing state", state.id, err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ processed: states.length }) };
};
