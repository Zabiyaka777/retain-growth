import type { SupabaseClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./activity-log";

/**
 * Single writer for leads.blocked_bot, called from both detection paths
 * (telegram-webhook.ts's my_chat_member branch, and the 403-on-send fallback
 * in funnel-graph.ts/send-message.ts) so the flag and its activity-log entry
 * never drift apart. Best effort: a lead's bot-blocked status is a signal for
 * managers, never something a send/webhook response depends on.
 */
export async function markBotBlocked(
  supabase: SupabaseClient,
  orgId: string,
  leadId: string,
  blocked: boolean,
): Promise<void> {
  const { error } = await supabase.from("leads").update({ blocked_bot: blocked }).eq("id", leadId).eq("org_id", orgId);
  if (error) {
    console.error("bot-block: leads update failed", leadId, error);
    return;
  }
  await logLeadActivity(supabase, {
    orgId,
    leadId,
    actionType: blocked ? "bot_blocked" : "bot_unblocked",
    actorType: "system",
  });
}
