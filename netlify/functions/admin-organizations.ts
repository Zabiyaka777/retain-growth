import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { logAdminAction, requirePlatformAdmin } from "./_shared/platform-admin";

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

interface OrgRow {
  id: string;
  name: string;
  created_at: string;
}

/**
 * Read-only overview of every organization on the platform.
 *
 * Deliberately metadata only — counts and timestamps, never lead names,
 * message bodies or credentials. An operator checking whether a tenant is
 * healthy doesn't need to read their customers' conversations, and this
 * endpoint is the wrong place to make that possible.
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

  let search = "";
  let orgId: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    search = typeof body.search === "string" ? body.search.trim() : "";
    orgId = typeof body.orgId === "string" ? body.orgId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) {
    return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });
  }

  let query = supabase.from("organizations").select("id, name, created_at").order("created_at", { ascending: false });
  if (orgId) query = query.eq("id", orgId);
  // Escaped so a name containing % or _ is matched literally rather than as
  // a wildcard.
  else if (search) query = query.ilike("name", `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%`);

  const { data: orgs, error: orgsError } = await query;

  if (orgsError) {
    console.error("admin-organizations: orgs query failed", orgsError);
    return jsonResponse(500, { error: "Не вдалося отримати список організацій" });
  }

  const ids = (orgs ?? []).map((o) => o.id as string);

  if (ids.length === 0) {
    await logAdminAction(supabase, admin, "organizations_list", { search, result_count: 0 });
    return jsonResponse(200, { ok: true, organizations: [] });
  }

  // Three grouped reads instead of per-org queries: the org list is short, but
  // a query per row would still be N+1 the moment the platform grows.
  const [leadsRes, channelsRes, threadsRes] = await Promise.all([
    supabase.from("leads").select("org_id").in("org_id", ids),
    supabase.from("channel_credentials").select("org_id, channel_type").in("org_id", ids),
    supabase.from("threads").select("org_id, updated_at").in("org_id", ids).order("updated_at", { ascending: false }),
  ]);

  const leadCounts = new Map<string, number>();
  for (const row of leadsRes.data ?? []) {
    const id = row.org_id as string;
    leadCounts.set(id, (leadCounts.get(id) ?? 0) + 1);
  }

  const channels = new Map<string, string[]>();
  for (const row of channelsRes.data ?? []) {
    const id = row.org_id as string;
    channels.set(id, [...(channels.get(id) ?? []), row.channel_type as string]);
  }

  // Rows arrive newest-first, so the first one seen per org is its latest.
  const lastActivity = new Map<string, string>();
  for (const row of threadsRes.data ?? []) {
    const id = row.org_id as string;
    if (!lastActivity.has(id)) lastActivity.set(id, row.updated_at as string);
  }

  const organizations = (orgs as OrgRow[]).map((org) => ({
    id: org.id,
    name: org.name,
    created_at: org.created_at,
    lead_count: leadCounts.get(org.id) ?? 0,
    channels: channels.get(org.id) ?? [],
    last_thread_at: lastActivity.get(org.id) ?? null,
  }));

  await logAdminAction(
    supabase,
    admin,
    orgId ? "organization_detail" : "organizations_list",
    { search, result_count: organizations.length },
    orgId ?? null,
  );

  return jsonResponse(200, { ok: true, organizations });
};
