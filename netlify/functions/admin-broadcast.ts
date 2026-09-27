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
const MAX_TITLE = 120;
const MAX_BODY = 1000;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// A platform admin's message to every organization or to one — one
// `notifications` row per target org (source 'admin_broadcast'), which each
// org then sees under its sidebar bell. linkUrl: an in-app path (/dashboard/…)
// or an absolute http(s) URL, nothing else (it becomes an <a href>).
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let title = "";
  let body = "";
  let linkUrl: string | null = null;
  let orgId: string | null = null; // null = all organizations
  try {
    const b = JSON.parse(event.body || "{}");
    title = typeof b.title === "string" ? b.title.trim() : "";
    body = typeof b.body === "string" ? b.body.trim() : "";
    linkUrl = typeof b.linkUrl === "string" && b.linkUrl.trim() ? b.linkUrl.trim() : null;
    orgId = typeof b.orgId === "string" && b.orgId ? b.orgId : null;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!title) return jsonResponse(400, { error: "Заголовок обов'язковий" });
  if (title.length > MAX_TITLE) return jsonResponse(400, { error: `Заголовок — до ${MAX_TITLE} символів` });
  if (body.length > MAX_BODY) return jsonResponse(400, { error: `Текст — до ${MAX_BODY} символів` });
  if (linkUrl && !/^https?:\/\//i.test(linkUrl) && !/^\/(?!\/)/.test(linkUrl)) {
    return jsonResponse(400, { error: "Посилання — шлях у застосунку (/dashboard/…) або https://…" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });

  let targets: string[];
  if (orgId) {
    const { data: org } = await supabase.from("organizations").select("id").eq("id", orgId).maybeSingle();
    if (!org) return jsonResponse(404, { error: "Організацію не знайдено" });
    targets = [orgId];
  } else {
    const { data: orgs, error } = await supabase.from("organizations").select("id");
    if (error) {
      console.error("admin-broadcast: organizations lookup failed", error);
      return jsonResponse(500, { error: "Не вдалося отримати список організацій" });
    }
    targets = (orgs ?? []).map((o) => o.id as string);
  }
  if (targets.length === 0) return jsonResponse(200, { ok: true, sent: 0 });

  const { error: insertError } = await supabase
    .from("notifications")
    .insert(targets.map((id) => ({ org_id: id, source: "admin_broadcast", title, body, link_url: linkUrl })));
  if (insertError) {
    console.error("admin-broadcast: insert failed", insertError);
    return jsonResponse(500, { error: "Не вдалося надіслати" });
  }

  await logAdminAction(supabase, admin, "notification_broadcast", { title, target: orgId ?? "all", sent: targets.length }, orgId);
  return jsonResponse(200, { ok: true, sent: targets.length });
};
