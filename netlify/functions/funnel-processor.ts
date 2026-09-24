import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface FunnelStep {
  type: "message" | "wait";
  text?: string;
  minutes?: number;
}

interface ClaimedState {
  id: string;
  thread_id: string;
  org_id: string;
  funnel_id: string;
  current_step: number;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
}

// Guards against a malformed definition (e.g. consecutive 'wait' steps)
// looping forever within a single invocation.
const MAX_STEP_ADVANCES = 50;
const CLAIM_BATCH_SIZE = 20;

export const handler: Handler = async () => {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_due_funnel_states", {
    p_limit: CLAIM_BATCH_SIZE,
  });

  if (claimError) {
    console.error("funnel-processor: claim_due_funnel_states failed", claimError);
    return { statusCode: 500, body: "claim failed" };
  }

  const states = (claimed ?? []) as ClaimedState[];

  for (const state of states) {
    try {
      await processState(supabase, state);
    } catch (err) {
      console.error("funnel-processor: unhandled error processing state", state.id, err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ processed: states.length }) };
};

async function processState(supabase: SupabaseClient, state: ClaimedState) {
  const { data: funnel, error: funnelError } = await supabase
    .from("funnels")
    .select("definition")
    .eq("id", state.funnel_id)
    .eq("org_id", state.org_id)
    .single();

  if (funnelError || !funnel) {
    console.error("funnel-processor: funnel not found", state.funnel_id, funnelError);
    return;
  }

  const definition = funnel.definition as FunnelStep[];

  let currentStep = state.current_step;
  let step = definition[currentStep];

  // Landing on a 'wait' step means its timer already elapsed (that's why
  // this row was due) — consume it and move to whatever comes after.
  let advances = 0;
  while (step?.type === "wait" && advances < MAX_STEP_ADVANCES) {
    currentStep += 1;
    step = definition[currentStep];
    advances += 1;
  }

  if (!step) {
    await markStatus(supabase, state.id, "completed", currentStep);
    return;
  }

  if (step.type === "message" && step.text) {
    const sent = await sendFunnelMessage(supabase, state, step.text);
    if (!sent) {
      // Leave the row as-is — claim_due_funnel_states already leased it for
      // 2 minutes, so it will be retried automatically without a 4th status.
      return;
    }
    currentStep += 1;
  } else {
    // Unrecognized step shape — skip rather than getting the thread stuck.
    console.error("funnel-processor: unsupported step, skipping", state.funnel_id, currentStep, step);
    currentStep += 1;
  }

  const nextStep = definition[currentStep];

  if (!nextStep) {
    await markStatus(supabase, state.id, "completed", currentStep);
    return;
  }

  if (nextStep.type === "wait" && typeof nextStep.minutes === "number") {
    const waitingUntil = new Date(Date.now() + nextStep.minutes * 60_000).toISOString();
    await supabase
      .from("funnel_states")
      .update({ current_step: currentStep, waiting_until: waitingUntil })
      .eq("id", state.id);
  } else {
    // No wait before the next step — make it due immediately (next tick).
    await supabase
      .from("funnel_states")
      .update({ current_step: currentStep, waiting_until: new Date().toISOString() })
      .eq("id", state.id);
  }
}

async function markStatus(supabase: SupabaseClient, stateId: string, status: string, currentStep: number) {
  await supabase.from("funnel_states").update({ status, current_step: currentStep }).eq("id", stateId);
}

async function sendFunnelMessage(supabase: SupabaseClient, state: ClaimedState, text: string): Promise<boolean> {
  const { data: threadInfo, error: threadError } = await supabase
    .from("threads")
    .select("channel_type, leads ( external_id )")
    .eq("id", state.thread_id)
    .eq("org_id", state.org_id)
    .single();

  if (threadError || !threadInfo) {
    console.error("funnel-processor: thread not found", state.thread_id, threadError);
    return false;
  }

  const lead = (threadInfo as unknown as { leads: { external_id: string } | null }).leads;
  const chatId = lead?.external_id;
  if (!chatId) {
    console.error("funnel-processor: lead not found for thread", state.thread_id);
    return false;
  }

  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", state.org_id)
    .eq("channel_type", threadInfo.channel_type as string)
    .maybeSingle();

  if (credentialError || !credential) {
    console.error("funnel-processor: no channel credential for org", state.org_id);
    return false;
  }

  const { data: botToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });

  if (tokenError || !botToken) {
    console.error("funnel-processor: vault_read_secret failed", tokenError);
    return false;
  }

  const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const sendData = (await sendRes.json()) as TelegramApiResponse;

  if (!sendRes.ok || !sendData.ok) {
    console.error("funnel-processor: sendMessage failed", sendData);
    return false;
  }

  await supabase.from("messages").insert({
    org_id: state.org_id,
    thread_id: state.thread_id,
    direction: "outbound",
    body: text,
    sender: "system",
  });

  return true;
}
