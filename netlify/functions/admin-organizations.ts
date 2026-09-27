import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logAdminAction, requirePlatformAdmin } from "./_shared/platform-admin";
import { calcSubscriptionPrice } from "./_shared/subscriptionPricing";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const PLAN_STATUSES = ["trial", "free", "active"] as const;
type PlanStatus = (typeof PLAN_STATUSES)[number];
// Same length BillingPanel.tsx counts the trial against.
const TRIAL_DAYS = 14;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface OrgRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  base_currency: string;
}

interface AddonJoin {
  org_id: string;
  quantity: number;
  enabled_at: string;
  billing_addons: { key: string; name: string; price_monthly: number } | null;
}

interface DiscountRow {
  id: string;
  org_id: string;
  label: string;
  percent: number;
  expires_at: string | null;
  created_at: string;
}

// The same bill BillingPanel.tsx shows the org itself: calcSubscriptionPrice
// off subscriber count + manager seats (the only addon left, 'extra_seat'),
// minus every unexpired discount (stacked, capped at 100%). `addons` only
// ever contains 'extra_seat' rows now — the other five billing_addons keys
// were retired (see the retire_module_billing_addons migration).
function computeBill(subscriberCount: number, addons: AddonJoin[], discounts: DiscountRow[]) {
  const managerSeats = addons.find((a) => a.billing_addons?.key === "extra_seat")?.quantity ?? 0;
  const gross = calcSubscriptionPrice(subscriberCount, managerSeats);
  const now = Date.now();
  const discountPct = Math.min(
    100,
    discounts.filter((d) => !d.expires_at || Date.parse(d.expires_at) > now).reduce((sum, d) => sum + Number(d.percent), 0),
  );
  const net = Math.max(0, gross * (1 - discountPct / 100));
  return { gross, discountPct, net: Math.round(net * 100) / 100, subscriberCount, managerSeats };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    out.set(k, [...(out.get(k) ?? []), row]);
  }
  return out;
}

async function emailsById(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const { data } = await supabase.auth.admin.getUserById(id);
      out.set(id, data.user?.email ?? null);
    }),
  );
  return out;
}

/**
 * Platform-admin surface for organizations, one endpoint with an action field:
 *   list (default)    — every org with its billing summary + platform totals
 *   detail            — one org's profile: owner/members, billing, activity
 *                       counts and a merged timeline (admin audit + events)
 *   set_plan_status   — trial / free / active on org_billing_state
 *   set_trial_end     — move trial_ends_at (and put the org back on trial)
 *   set_addon         — enable / disable / change quantity of one addon
 *   remove_addons     — drop every enabled addon (what trial expiry does)
 *
 * Still metadata only — counts and timestamps, never lead names, message
 * bodies or credentials. Every call is written to admin_audit_log.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  const action = typeof body.action === "string" ? body.action : "list";
  const orgId = typeof body.orgId === "string" && UUID_RE.test(body.orgId) ? body.orgId : undefined;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) {
    return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });
  }

  if (action === "list") {
    const search = typeof body.search === "string" ? body.search.trim() : "";
    let query = supabase.from("organizations").select("id, name, owner_id, created_at, base_currency").order("created_at", { ascending: false });
    // Escaped so a name containing % or _ is matched literally rather than as a wildcard.
    if (search) query = query.ilike("name", `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%`);
    const { data: orgs, error: orgsError } = await query;
    if (orgsError) {
      console.error("admin-organizations: orgs query failed", orgsError);
      return jsonResponse(500, { error: "Не вдалося отримати список організацій" });
    }
    const list = (orgs ?? []) as OrgRow[];
    const ids = list.map((o) => o.id);
    if (ids.length === 0) {
      await logAdminAction(supabase, admin, "organizations_list", { search, result_count: 0 });
      return jsonResponse(200, { ok: true, organizations: [], totals: null });
    }

    // Grouped reads instead of per-org queries.
    const [leadsRes, subsRes, channelsRes, threadsRes, stateRes, addonsRes, discountsRes, membersRes] = await Promise.all([
      supabase.from("leads").select("org_id").in("org_id", ids),
      supabase.from("leads").select("org_id").in("org_id", ids).eq("subscribed", true),
      supabase.from("channel_credentials").select("org_id, channel_type").in("org_id", ids),
      supabase.from("threads").select("org_id, updated_at").in("org_id", ids).order("updated_at", { ascending: false }),
      supabase.from("org_billing_state").select("org_id, plan_status, trial_ends_at").in("org_id", ids),
      supabase.from("org_billing_addons").select("org_id, quantity, enabled_at, billing_addons ( key, name, price_monthly )").in("org_id", ids),
      supabase.from("org_discounts").select("id, org_id, label, percent, expires_at, created_at").in("org_id", ids),
      supabase.from("profiles").select("org_id").in("org_id", ids),
    ]);

    const count = (rows: { org_id: string }[] | null) => {
      const m = new Map<string, number>();
      for (const r of rows ?? []) m.set(r.org_id, (m.get(r.org_id) ?? 0) + 1);
      return m;
    };
    const leadCounts = count(leadsRes.data as { org_id: string }[] | null);
    const subscriberCounts = count(subsRes.data as { org_id: string }[] | null);
    const memberCounts = count(membersRes.data as { org_id: string }[] | null);
    const channels = groupBy((channelsRes.data ?? []) as { org_id: string; channel_type: string }[], (r) => r.org_id);
    const lastActivity = new Map<string, string>();
    for (const row of threadsRes.data ?? []) {
      if (!lastActivity.has(row.org_id as string)) lastActivity.set(row.org_id as string, row.updated_at as string);
    }
    const states = new Map(((stateRes.data ?? []) as { org_id: string; plan_status: PlanStatus; trial_ends_at: string }[]).map((s) => [s.org_id, s]));
    const addons = groupBy((addonsRes.data ?? []) as unknown as AddonJoin[], (a) => a.org_id);
    const discounts = groupBy((discountsRes.data ?? []) as DiscountRow[], (d) => d.org_id);
    const owners = await emailsById(supabase, list.map((o) => o.owner_id));

    const organizations = list.map((org) => {
      const state = states.get(org.id) ?? null;
      const bill = computeBill(subscriberCounts.get(org.id) ?? 0, addons.get(org.id) ?? [], discounts.get(org.id) ?? []);
      return {
        id: org.id,
        name: org.name,
        created_at: org.created_at,
        owner_email: owners.get(org.owner_id) ?? null,
        plan_status: state?.plan_status ?? null,
        trial_ends_at: state?.trial_ends_at ?? null,
        addons_count: (addons.get(org.id) ?? []).length,
        bill,
        members: memberCounts.get(org.id) ?? 0,
        lead_count: leadCounts.get(org.id) ?? 0,
        channels: (channels.get(org.id) ?? []).map((c) => c.channel_type),
        last_thread_at: lastActivity.get(org.id) ?? null,
      };
    });

    // Platform totals always over every org, not just the search result.
    let totals = null;
    if (!search) {
      const byStatus = { trial: 0, free: 0, active: 0, none: 0 };
      let mrr = 0;
      let trialPipeline = 0;
      const since = Date.now() - 30 * 86_400_000;
      let new30 = 0;
      let active30 = 0;
      for (const o of organizations) {
        byStatus[(o.plan_status ?? "none") as keyof typeof byStatus] += 1;
        if (o.plan_status === "active") mrr += o.bill.net;
        if (o.plan_status === "trial") trialPipeline += o.bill.net;
        if (Date.parse(o.created_at) > since) new30 += 1;
        if (o.last_thread_at && Date.parse(o.last_thread_at) > since) active30 += 1;
      }
      totals = {
        organizations: organizations.length,
        by_status: byStatus,
        mrr: Math.round(mrr * 100) / 100,
        trial_pipeline: Math.round(trialPipeline * 100) / 100,
        new_30d: new30,
        active_30d: active30,
        leads: organizations.reduce((n, o) => n + o.lead_count, 0),
      };
    }

    await logAdminAction(supabase, admin, "organizations_list", { search, result_count: organizations.length });
    return jsonResponse(200, { ok: true, organizations, totals });
  }

  if (!orgId) return jsonResponse(400, { error: "orgId обов'язковий" });

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, owner_id, created_at, base_currency")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) {
    console.error("admin-organizations: org lookup failed", orgError);
    return jsonResponse(500, { error: "Не вдалося прочитати організацію" });
  }
  if (!org) return jsonResponse(404, { error: "Організацію не знайдено" });

  if (action === "detail") {
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [stateRes, addonsRes, catalogRes, discountsRes, membersRes, channelsRes, leadsRes, subsRes, threadsRes, msgs30Res, lastThreadRes, auditRes, eventsRes, landingsRes, linksRes, funnelsRes] =
      await Promise.all([
        supabase.from("org_billing_state").select("plan_status, trial_started_at, trial_ends_at, created_at").eq("org_id", orgId).maybeSingle(),
        supabase.from("org_billing_addons").select("org_id, quantity, enabled_at, billing_addons ( key, name, price_monthly )").eq("org_id", orgId),
        supabase.from("billing_addons").select("key, name, price_monthly, description").order("price_monthly"),
        supabase.from("org_discounts").select("id, org_id, label, percent, expires_at, created_at").eq("org_id", orgId).order("created_at", { ascending: false }),
        supabase.from("profiles").select("id, created_at").eq("org_id", orgId),
        supabase.from("channel_credentials").select("channel_type").eq("org_id", orgId),
        supabase.from("leads").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        supabase.from("leads").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("subscribed", true),
        supabase.from("threads").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        supabase.from("messages").select("id", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", since30),
        supabase.from("threads").select("updated_at").eq("org_id", orgId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("admin_audit_log").select("id, admin_user_id, action, details, created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(80),
        supabase.from("events").select("id, type, level, payload, created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(80),
        supabase.from("landing_pages").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        supabase.from("lead_gen_links").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        supabase.from("funnels").select("id", { count: "exact", head: true }).eq("org_id", orgId),
      ]);

    const members = (membersRes.data ?? []) as { id: string; created_at: string }[];
    const emails = await emailsById(supabase, [org.owner_id as string, ...members.map((m) => m.id)]);
    const addons = (addonsRes.data ?? []) as unknown as AddonJoin[];
    const discounts = (discountsRes.data ?? []) as DiscountRow[];
    const subscriberCount = subsRes.count ?? 0;

    await logAdminAction(supabase, admin, "organization_detail", {}, orgId);

    return jsonResponse(200, {
      ok: true,
      organization: {
        id: org.id,
        name: org.name,
        created_at: org.created_at,
        base_currency: org.base_currency,
        owner: { id: org.owner_id, email: emails.get(org.owner_id as string) ?? null },
        members: members.map((m) => ({ id: m.id, email: emails.get(m.id) ?? null, created_at: m.created_at, is_owner: m.id === org.owner_id })),
      },
      billing: {
        state: stateRes.data ?? null,
        addons: addons.map((a) => ({
          key: a.billing_addons?.key,
          name: a.billing_addons?.name,
          price_monthly: Number(a.billing_addons?.price_monthly ?? 0),
          quantity: a.quantity,
          enabled_at: a.enabled_at,
        })),
        catalog: catalogRes.data ?? [],
        discounts,
        bill: computeBill(subscriberCount, addons, discounts),
      },
      usage: {
        leads: leadsRes.count ?? 0,
        subscribers: subscriberCount,
        threads: threadsRes.count ?? 0,
        messages_30d: msgs30Res.count ?? 0,
        landings: landingsRes.count ?? 0,
        links: linksRes.count ?? 0,
        funnels: funnelsRes.count ?? 0,
        channels: (channelsRes.data ?? []).map((c) => c.channel_type as string),
        last_thread_at: (lastThreadRes.data?.updated_at as string | undefined) ?? null,
      },
      audit: auditRes.data ?? [],
      events: eventsRes.data ?? [],
    });
  }

  if (action === "set_plan_status") {
    const status = body.status as PlanStatus;
    if (!PLAN_STATUSES.includes(status)) return jsonResponse(400, { error: "status має бути trial, free або active" });
    const { data: before } = await supabase.from("org_billing_state").select("plan_status, trial_ends_at").eq("org_id", orgId).maybeSingle();
    const now = new Date();
    const patch: Record<string, unknown> = { plan_status: status };
    // A fresh trial needs dates; an org that never had a billing row gets one
    // (trial dates are NOT NULL, so a row can't exist without them).
    if (status === "trial" && (!before || Date.parse(before.trial_ends_at as string) < now.getTime())) {
      patch.trial_started_at = now.toISOString();
      patch.trial_ends_at = new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString();
    } else if (!before) {
      patch.trial_started_at = now.toISOString();
      patch.trial_ends_at = now.toISOString();
    }
    // Update vs insert, not upsert: an upsert sends the partial row as the
    // INSERT tuple too, and that trips the NOT NULL trial dates even when the
    // row already exists.
    const { error } = before
      ? await supabase.from("org_billing_state").update(patch).eq("org_id", orgId)
      : await supabase.from("org_billing_state").insert({ org_id: orgId, ...patch });
    if (error) {
      console.error("admin-organizations: set_plan_status failed", error);
      return jsonResponse(500, { error: "Не вдалося змінити статус плану" });
    }
    await logAdminAction(supabase, admin, "org_plan_status_set", { from: before?.plan_status ?? null, to: status }, orgId);
    return jsonResponse(200, { ok: true });
  }

  if (action === "set_trial_end") {
    const iso = typeof body.trialEndsAt === "string" ? body.trialEndsAt : "";
    const ends = Date.parse(iso);
    if (!Number.isFinite(ends) || ends < Date.now()) return jsonResponse(400, { error: "Дата кінця тріалу має бути в майбутньому" });
    const { data: before } = await supabase.from("org_billing_state").select("plan_status, trial_ends_at, trial_started_at").eq("org_id", orgId).maybeSingle();
    const { error } = await supabase.from("org_billing_state").upsert(
      {
        org_id: orgId,
        plan_status: "trial",
        trial_started_at: before?.trial_started_at ?? new Date().toISOString(),
        trial_ends_at: new Date(ends).toISOString(),
      },
      { onConflict: "org_id" },
    );
    if (error) {
      console.error("admin-organizations: set_trial_end failed", error);
      return jsonResponse(500, { error: "Не вдалося змінити дату тріалу" });
    }
    await logAdminAction(
      supabase,
      admin,
      "org_trial_end_set",
      { from: before?.trial_ends_at ?? null, to: new Date(ends).toISOString(), status_before: before?.plan_status ?? null },
      orgId,
    );
    return jsonResponse(200, { ok: true });
  }

  if (action === "set_addon") {
    const addonKey = typeof body.addonKey === "string" ? body.addonKey : "";
    const enabled = body.enabled === true;
    const quantity = typeof body.quantity === "number" && Number.isInteger(body.quantity) && body.quantity >= 1 ? body.quantity : 1;
    const { data: addon } = await supabase.from("billing_addons").select("id, name").eq("key", addonKey).maybeSingle();
    if (!addon) return jsonResponse(404, { error: "Модуль не знайдено" });
    // Same semantics as toggle-billing-addon.ts: a row existing IS "enabled".
    const { error } = enabled
      ? await supabase.from("org_billing_addons").upsert({ org_id: orgId, addon_id: addon.id, quantity }, { onConflict: "org_id,addon_id" })
      : await supabase.from("org_billing_addons").delete().eq("org_id", orgId).eq("addon_id", addon.id);
    if (error) {
      console.error("admin-organizations: set_addon failed", error);
      return jsonResponse(500, { error: "Не вдалося змінити модуль" });
    }
    await logAdminAction(supabase, admin, enabled ? "org_addon_enabled" : "org_addon_disabled", { addon: addonKey, name: addon.name, quantity: enabled ? quantity : null }, orgId);
    return jsonResponse(200, { ok: true });
  }

  if (action === "remove_addons") {
    const { error, count } = await supabase.from("org_billing_addons").delete({ count: "exact" }).eq("org_id", orgId);
    if (error) {
      console.error("admin-organizations: remove_addons failed", error);
      return jsonResponse(500, { error: "Не вдалося вимкнути модулі" });
    }
    await logAdminAction(supabase, admin, "org_addons_removed", { removed: count ?? 0 }, orgId);
    return jsonResponse(200, { ok: true, removed: count ?? 0 });
  }

  return jsonResponse(400, { error: "Невідома дія" });
};
