import type { SupabaseClient } from "@supabase/supabase-js";

// One place where "a lead entered a stage" turns into a Meta conversion, so
// every writer of lead_stage_history behaves identically: the conversion node
// in funnel-graph.ts, the manual save in save-lead-stage.ts, and the initial
// «Підписка» row the leads insert trigger writes (dispatched from
// telegram-webhook.ts once the lead actually has a source link).

// Meta rejects any event older than 7 days, so a backfilled or long-delayed
// entry is dropped here rather than sent to be refused.
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface StageEntry {
  /** lead_stage_history.id — doubles as the Meta event_id for dedupe. */
  historyId: string;
  orgId: string;
  leadId: string;
  stageId: string;
  value: number | null;
  /** When the transition actually happened, not when this ran. */
  enteredAt: string;
}

type SkipReason =
  | "no_source_link"
  | "no_pixel_id"
  | "no_token"
  | "event_time_too_old"
  | "no_site_url"
  | "value_required";

// Meta rejects a Purchase that carries no amount (error_subcode 2804009) and
// no currency (2804010). Currency we always send; an amount only exists when
// someone typed one, so a Purchase without one is skipped rather than sent as
// a guaranteed rejection — or, worse, invented as 0 and quietly wrecking ROAS.
const VALUE_REQUIRED_EVENTS = new Set(["Purchase"]);

interface StageConversionConfig {
  track_as_conversion: boolean;
  meta_event_name: string | null;
}

// A custom stage carries its own config. A built-in one (org_id NULL) is a
// single row shared by every org, so its config lives per-org in
// org_stage_conversion instead — otherwise one org enabling «Підписка»
// tracking would enable it for all of them.
async function resolveStageConfig(
  supabase: SupabaseClient,
  orgId: string,
  stageId: string,
): Promise<StageConversionConfig | null> {
  const { data: stage, error: stageError } = await supabase
    .from("funnel_stages")
    .select("org_id, track_as_conversion, meta_event_name")
    .eq("id", stageId)
    .maybeSingle();

  if (stageError) {
    console.error("stage-conversion: funnel_stages lookup failed", stageError);
    return null;
  }
  if (!stage) return null;

  if (stage.org_id !== null) {
    return {
      track_as_conversion: stage.track_as_conversion as boolean,
      meta_event_name: (stage.meta_event_name as string | null) ?? null,
    };
  }

  const { data: override, error: overrideError } = await supabase
    .from("org_stage_conversion")
    .select("track_as_conversion, meta_event_name")
    .eq("org_id", orgId)
    .eq("stage_id", stageId)
    .maybeSingle();

  if (overrideError) {
    console.error("stage-conversion: org_stage_conversion lookup failed", overrideError);
    return null;
  }
  if (!override) return { track_as_conversion: false, meta_event_name: null };

  return {
    track_as_conversion: override.track_as_conversion as boolean,
    meta_event_name: (override.meta_event_name as string | null) ?? null,
  };
}

async function logSkip(
  supabase: SupabaseClient,
  orgId: string,
  reason: SkipReason,
  entry: StageEntry,
  linkId: string | null,
): Promise<void> {
  const { error } = await supabase.from("events").insert({
    org_id: orgId,
    type: "meta_capi_skipped",
    level: "warn",
    payload: {
      reason,
      source: "stage_conversion",
      link_id: linkId,
      lead_id: entry.leadId,
      stage_id: entry.stageId,
      history_id: entry.historyId,
    },
  });
  if (error) console.error("stage-conversion: events insert failed", error);
}

/**
 * Sends a Meta conversion for one stage entry, when the stage is configured
 * for it. Never throws and never blocks the caller's own write: a lead's
 * progress must not fail over an ad-tracking setting.
 *
 * A stage with track_as_conversion = false returns before any lookup, log or
 * HTTP request — an untracked stage isn't a skip, it's simply not configured.
 */
export async function maybeSendStageConversion(supabase: SupabaseClient, entry: StageEntry): Promise<void> {
  const config = await resolveStageConfig(supabase, entry.orgId, entry.stageId);
  if (!config?.track_as_conversion) return;

  const eventName = config.meta_event_name?.trim() || "Lead";

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("source_link_id, source_click_id, channel_type")
    .eq("id", entry.leadId)
    .eq("org_id", entry.orgId)
    .maybeSingle();

  if (leadError) console.error("stage-conversion: leads lookup failed", leadError);

  const linkId = (lead?.source_link_id as string | null) ?? null;
  if (!linkId) {
    await logSkip(supabase, entry.orgId, "no_source_link", entry, null);
    return;
  }

  const { data: link, error: linkError } = await supabase
    .from("lead_gen_links")
    .select("pixel_id, ref_token, meta_access_token_secret_id")
    .eq("id", linkId)
    .maybeSingle();

  if (linkError) console.error("stage-conversion: lead_gen_links lookup failed", linkError);

  const pixelId = (link?.pixel_id as string | null) ?? null;
  if (!pixelId) {
    await logSkip(supabase, entry.orgId, "no_pixel_id", entry, linkId);
    return;
  }
  if (!link?.meta_access_token_secret_id) {
    await logSkip(supabase, entry.orgId, "no_token", entry, linkId);
    return;
  }

  if (VALUE_REQUIRED_EVENTS.has(eventName) && entry.value === null) {
    await logSkip(supabase, entry.orgId, "value_required", entry, linkId);
    return;
  }

  const enteredAtMs = new Date(entry.enteredAt).getTime();
  if (!Number.isFinite(enteredAtMs) || Date.now() - enteredAtMs > MAX_EVENT_AGE_MS) {
    await logSkip(supabase, entry.orgId, "event_time_too_old", entry, linkId);
    return;
  }

  // The lead's own first-touch click — the only click we can attribute to
  // this person, which is what carries fbc/IP/UA for matching.
  let click: { fbclid: string | null; ip: string | null; user_agent: string | null; clicked_at: string } | null = null;
  const clickId = (lead?.source_click_id as string | null) ?? null;
  if (clickId) {
    const { data, error } = await supabase
      .from("link_clicks")
      .select("fbclid, ip, user_agent, clicked_at")
      .eq("click_id", clickId)
      .maybeSingle();
    if (error) console.error("stage-conversion: link_clicks lookup failed", error);
    click = data ?? null;
  }

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    console.error("stage-conversion: URL сайту не сконфігуровано, не можу викликати meta-capi-send");
    await logSkip(supabase, entry.orgId, "no_site_url", entry, linkId);
    return;
  }

  try {
    await fetch(`${siteUrl}/.netlify/functions/meta-capi-send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        linkId,
        pixelId,
        eventName,
        value: entry.value,
        channelType: (lead?.channel_type as string | null) ?? null,
        fbclid: click?.fbclid ?? null,
        clickTimestampMs: click ? new Date(click.clicked_at).getTime() : null,
        ip: click?.ip ?? null,
        userAgent: click?.user_agent ?? null,
        eventSourceUrl: link?.ref_token ? `${siteUrl}/r/${link.ref_token}` : null,
        // The transition's own moment, so a delayed or replayed dispatch
        // still reports when the lead actually converted.
        eventTimeMs: enteredAtMs,
        // Stable per history row: a retried dispatch dedupes on Meta's side
        // instead of double-counting the same conversion.
        eventId: `stage-${entry.historyId}`,
      }),
    });
  } catch (err) {
    console.error("stage-conversion: meta-capi-send invoke failed", err);
  }
}

/**
 * Dispatches the lead's first stage entry — the «Підписка» row the leads
 * insert trigger writes. Called once attribution has been set: at insert time
 * the lead has no source_link_id yet, so a send from the trigger's own moment
 * could only ever skip.
 */
export async function dispatchInitialStageConversion(
  supabase: SupabaseClient,
  orgId: string,
  leadId: string,
): Promise<void> {
  const { data: row, error } = await supabase
    .from("lead_stage_history")
    .select("id, stage_id, value, entered_at")
    .eq("lead_id", leadId)
    .eq("org_id", orgId)
    .order("entered_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("stage-conversion: initial history lookup failed", error);
    return;
  }
  if (!row) return;

  await maybeSendStageConversion(supabase, {
    historyId: row.id as string,
    orgId,
    leadId,
    stageId: row.stage_id as string,
    value: (row.value as number | null) ?? null,
    enteredAt: row.entered_at as string,
  });
}
