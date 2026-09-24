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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Platform-wide view of the `events` table — the operational signal that is
 * otherwise invisible: rejected webhooks, failed Meta conversions, missing AI
 * credentials, transcription failures.
 *
 * `events` has no RLS select policy (service-role writes only), so this
 * endpoint is the only way it is ever read, and it reads nothing without a
 * verified platform admin.
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

  let type: string | undefined;
  let level: string | undefined;
  let orgId: string | undefined;
  let limit = DEFAULT_LIMIT;
  try {
    const body = JSON.parse(event.body || "{}");
    type = typeof body.type === "string" && body.type ? body.type : undefined;
    level = typeof body.level === "string" && body.level ? body.level : undefined;
    orgId = typeof body.orgId === "string" && body.orgId ? body.orgId : undefined;
    if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
      limit = Math.min(Math.max(Math.floor(body.limit), 1), MAX_LIMIT);
    }
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

  let query = supabase
    .from("events")
    .select("id, org_id, type, level, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (type) query = query.eq("type", type);
  if (level) query = query.eq("level", level);
  if (orgId) query = query.eq("org_id", orgId);

  const { data: events, error: eventsError } = await query;

  if (eventsError) {
    console.error("admin-events: query failed", eventsError);
    return jsonResponse(500, { error: "Не вдалося отримати події" });
  }

  // The type list drives the filter dropdown and comes from the data itself —
  // hardcoding it would silently omit any event type added later.
  const { data: typeRows, error: typesError } = await supabase
    .from("events")
    .select("type")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (typesError) console.error("admin-events: type list query failed", typesError);

  const types = [...new Set((typeRows ?? []).map((r) => r.type as string))].sort();

  // Org names so the table can show something a human recognises instead of
  // a bare uuid.
  const orgIds = [...new Set((events ?? []).map((e) => e.org_id as string).filter(Boolean))];
  const orgNames: Record<string, string> = {};
  if (orgIds.length > 0) {
    const { data: orgs } = await supabase.from("organizations").select("id, name").in("id", orgIds);
    for (const org of orgs ?? []) orgNames[org.id as string] = org.name as string;
  }

  await logAdminAction(
    supabase,
    admin,
    "events_list",
    { type: type ?? null, level: level ?? null, result_count: events?.length ?? 0 },
    orgId ?? null,
  );

  return jsonResponse(200, { ok: true, events: events ?? [], types, orgNames });
};
