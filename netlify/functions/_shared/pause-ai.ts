import type { SupabaseClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./activity-log";

/**
 * A manager typing a reply by hand is itself "a human took over" — that's
 * true regardless of whether an explicit "Відкрити чат" action ever ran on
 * the graph. Stops every ai_active funnel_states row on this thread (a lead
 * can be ai_active in more than one funnel at once — see toggle-funnel.ts),
 * so the lead's next message isn't answered by both the manager and the
 * model.
 *
 * Soft-stop only (status='stopped'), the same approach manage-lead-funnel.ts
 * already uses for its own 'stop' action: the row and its history survive,
 * and the (thread_id, funnel_id) unique slot stays claimed rather than
 * quietly freeing up for an unrelated re-enrollment.
 */
export async function pauseAiForManualSend(
  supabase: SupabaseClient,
  params: { orgId: string; threadId: string; leadId: string; actorUserId: string | null; actorEmail?: string | null },
): Promise<void> {
  const { orgId, threadId, leadId, actorUserId, actorEmail } = params;

  const { data: activeStates, error: lookupError } = await supabase
    .from("funnel_states")
    .select("id, funnel_id, funnel_node_id")
    .eq("thread_id", threadId)
    .eq("status", "ai_active");

  if (lookupError) {
    console.error("pause-ai: ai_active lookup failed", lookupError);
    return;
  }
  if (!activeStates || activeStates.length === 0) return;

  const { error: updateError } = await supabase
    .from("funnel_states")
    .update({ status: "stopped" })
    .in(
      "id",
      activeStates.map((s) => s.id),
    );

  if (updateError) {
    console.error("pause-ai: stop failed", updateError);
    return;
  }

  // Names are cosmetic (for the activity-log line in Chats.tsx) — resolved
  // best-effort, after the actual stop already succeeded above.
  const funnelIds = [...new Set(activeStates.map((s) => s.funnel_id as string))];
  const nodeIds = activeStates.map((s) => s.funnel_node_id as string | null).filter((id): id is string => !!id);

  const [funnelsRes, nodesRes] = await Promise.all([
    supabase.from("funnels").select("id, name").in("id", funnelIds),
    nodeIds.length > 0 ? supabase.from("funnel_nodes").select("id, config").in("id", nodeIds) : Promise.resolve({ data: [] as { id: string; config: unknown }[] }),
  ]);

  const funnelNames = new Map((funnelsRes.data ?? []).map((f) => [f.id as string, f.name as string]));
  const nodeLabels = new Map(
    (nodesRes.data ?? []).map((n) => [n.id as string, (n.config as { label?: string } | null)?.label?.trim() || "AI"]),
  );

  for (const state of activeStates) {
    await logLeadActivity(supabase, {
      orgId,
      leadId,
      actionType: "ai_paused_by_manager",
      actorType: "manager",
      actorUserId,
      actorEmail,
      details: {
        funnel_name: funnelNames.get(state.funnel_id as string) ?? null,
        node_label: state.funnel_node_id ? nodeLabels.get(state.funnel_node_id as string) ?? null : null,
      },
    });
  }
}
