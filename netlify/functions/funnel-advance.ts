import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { processGraphState, type ClaimedState, type EnrollmentContext } from "./_shared/funnel-graph";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Deliberately has NO schedule in netlify.toml (unlike funnel-processor-v2.ts)
// — scheduled functions reject direct HTTP calls on Netlify, and this one
// exists specifically to be called directly by telegram-webhook.ts right
// after a callback_query, for immediate processing instead of waiting for cron.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  let stateId: string | undefined;
  let chosenButtonId: string | undefined;
  let callbackMessageId: number | null = null;
  let enrollment: EnrollmentContext | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    stateId = typeof body.stateId === "string" ? body.stateId : undefined;
    chosenButtonId = typeof body.chosenButtonId === "string" ? body.chosenButtonId : undefined;
    // Telegram's id for the tapped message, so the keyboard can be cleared
    // afterwards when the node asks for it.
    callbackMessageId = typeof body.callbackMessageId === "number" ? body.callbackMessageId : null;
    // Only telegram-webhook.ts's lead-gen-link enrollment sends this — a thin
    // marker (which link/click caused this state), not Meta CAPI data itself.
    // processGraphState looks up everything else it needs from it.
    if (body.enrollment && typeof body.enrollment.linkId === "string") {
      enrollment = {
        linkId: body.enrollment.linkId,
        clickId: typeof body.enrollment.clickId === "string" ? body.enrollment.clickId : null,
      };
    }
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!stateId) {
    return jsonResponse(400, { error: "stateId обов'язковий" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_specific_funnel_state", { p_id: stateId });
  if (claimError) {
    console.error("funnel-advance: claim_specific_funnel_state failed", claimError);
    return jsonResponse(500, { error: "claim failed" });
  }

  const state = ((claimed ?? []) as ClaimedState[])[0];
  if (!state) {
    return jsonResponse(200, { processed: 0 });
  }

  // A blocked or archived lead's thread stays fully readable (the
  // callback_query or /start that triggered this call was already recorded
  // upstream) — only the automated walk is withheld. The claimed state is
  // simply left as-is; it's inert until the lead's status changes or
  // something advances it another way.
  const { data: thread, error: threadError } = await supabase
    .from("threads")
    .select("lead_id, leads ( status )")
    .eq("id", state.thread_id)
    .maybeSingle();

  if (threadError) console.error("funnel-advance: thread lookup failed", threadError);

  const leadStatus = (thread as unknown as { leads: { status: string } | null } | null)?.leads?.status;
  if (leadStatus === "blocked" || leadStatus === "archived") {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: state.org_id,
      type: "blocked_lead_ignored",
      level: "info",
      payload: { source: "funnel-advance", thread_id: state.thread_id, lead_id: thread?.lead_id ?? null, lead_status: leadStatus },
    });
    if (eventError) console.error("funnel-advance: events insert failed", eventError);
    return jsonResponse(200, { processed: 0, reason: `lead_${leadStatus}` });
  }

  try {
    await processGraphState(supabase, state, chosenButtonId ?? null, enrollment ?? null, callbackMessageId);
  } catch (err) {
    console.error("funnel-advance: unhandled error processing state", state.id, err);
  }

  return jsonResponse(200, { processed: 1 });
};
