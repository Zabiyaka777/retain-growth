import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Logs the implicit "subscribe" every brand-new lead gets for free —
 * leads.subscribed defaults to true in the schema, so without an explicit
 * event for it, that default state never shows up in "Підписки за
 * джерелом" (which reads lead_subscription_events, not leads.subscribed
 * directly). Production had 7 subscribed leads and 0 subscribe events
 * before this existed.
 *
 * Call right after the lead upsert, before source_link_id attribution has
 * necessarily resolved — link_id starts null and gets patched in place by
 * patchInitialSubscribeLink if/when attribution lands later in the same
 * request. Returns the new event's id (for that patch), or null if
 * isNewLead was false or the insert failed.
 */
export async function logInitialSubscribeEvent(
  supabase: SupabaseClient,
  orgId: string,
  leadId: string,
  isNewLead: boolean,
): Promise<string | null> {
  if (!isNewLead) return null;

  const { data, error } = await supabase
    .from("lead_subscription_events")
    .insert({ org_id: orgId, lead_id: leadId, link_id: null, event_type: "subscribe" })
    .select("id")
    .single();

  if (error) {
    console.error("subscription-log: initial subscribe insert failed", error);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

/**
 * Patches the link_id of the event logInitialSubscribeEvent just created,
 * once first-touch attribution resolves for the same lead in the same
 * request. A no-op if there was no event to patch (returning lead, or the
 * insert above failed) — safe to call unconditionally.
 */
export async function patchInitialSubscribeLink(supabase: SupabaseClient, eventId: string | null, linkId: string): Promise<void> {
  if (!eventId) return;
  const { error } = await supabase.from("lead_subscription_events").update({ link_id: linkId }).eq("id", eventId);
  if (error) console.error("subscription-log: initial subscribe link patch failed", error);
}

/**
 * Logs a subscribe event for a lead-gen-link click that ISN'T the lead's
 * first ever (no fresh event from logInitialSubscribeEvent to patch) —
 * typically a returning lead re-entering via a link. source_link_id
 * attribution is first-touch-only (set once, never overwritten by a later
 * click — see the callers), but "Підписки за джерелом" is meant to count
 * every distinct click-through as its own subscribe for whichever link was
 * actually clicked. Without this, a returning lead's repeat click never
 * shows up anywhere in that report at all — confirmed live: clicking a
 * second link after the first-touch one had already been set produced zero
 * new events.
 */
export async function logRepeatSubscribeEvent(supabase: SupabaseClient, orgId: string, leadId: string, linkId: string): Promise<void> {
  const { error } = await supabase.from("lead_subscription_events").insert({ org_id: orgId, lead_id: leadId, link_id: linkId, event_type: "subscribe" });
  if (error) console.error("subscription-log: repeat subscribe insert failed", error);
}
