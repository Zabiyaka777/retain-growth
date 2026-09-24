import type { SupabaseClient } from "@supabase/supabase-js";

// One writer for lead_activity_log, so every endpoint records the same shape
// and none of them has to think about failure handling: a log write must
// never turn a successful action into a reported error.

export type ActorType = "manager" | "system" | "ai";

export interface ActivityEntry {
  orgId: string;
  leadId: string;
  actionType: string;
  actorType: ActorType;
  /** Only for 'manager' — the caller's auth.users id. */
  actorUserId?: string | null;
  /** The caller's email, used to derive the display name. */
  actorEmail?: string | null;
  details?: Record<string, unknown>;
}

/**
 * "olena@company.com" -> "olena". profiles carries no name column and
 * auth.users isn't readable from the browser, so the label is resolved here,
 * at write time, and stored with the entry.
 */
function displayName(email: string | null | undefined): string | null {
  if (!email) return null;
  const local = email.split("@")[0]?.trim();
  if (!local) return null;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * Appends one entry. Never throws: callers invoke it after the action they
 * describe has already succeeded, so a logging failure is logged to the
 * console and otherwise ignored.
 */
export async function logLeadActivity(supabase: SupabaseClient, entry: ActivityEntry): Promise<void> {
  const details = { ...(entry.details ?? {}) };
  const name = displayName(entry.actorEmail);
  if (name) details.actor_name = name;

  const { error } = await supabase.from("lead_activity_log").insert({
    org_id: entry.orgId,
    lead_id: entry.leadId,
    actor_type: entry.actorType,
    actor_user_id: entry.actorType === "manager" ? (entry.actorUserId ?? null) : null,
    action_type: entry.actionType,
    details,
  });

  if (error) console.error("activity-log: insert failed", entry.actionType, error);
}
