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

// Scheduled (netlify.toml: schedule = "0 4 * * *" — once a day, same
// not-urgent cadence as funnel-auto-stop.ts). Flips any org still 'trial'
// past its trial_ends_at over to 'free', then turns off every paid addon it
// had enabled — trial access was never actually paid for, so nothing paid
// carries over once it lapses. Doesn't touch anything else: leads, threads,
// funnels, tags, activity history are all untouched by this function.
export const handler: Handler = async () => {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_expired_trials", {
    p_limit: CLAIM_BATCH_SIZE,
  });

  if (claimError) {
    console.error("billing-trial-expire: claim_expired_trials failed", claimError);
    return { statusCode: 500, body: "claim failed" };
  }

  const orgIds = (claimed ?? []).map((row: { org_id: string }) => row.org_id);
  if (orgIds.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ expired: 0, addonsRemoved: 0 }) };
  }

  const { error: deleteError, count } = await supabase
    .from("org_billing_addons")
    .delete({ count: "exact" })
    .in("org_id", orgIds);

  if (deleteError) {
    console.error("billing-trial-expire: org_billing_addons delete failed", deleteError);
  }

  return { statusCode: 200, body: JSON.stringify({ expired: orgIds.length, addonsRemoved: count ?? 0 }) };
};
