import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Marks the caller's org's notifications as read — { ids: [...] } for specific
// ones, { all: true } for "Позначити всі прочитаними". notifications is
// SELECT-only for clients (like every other org table), so this is the write path.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let ids: string[] = [];
  let all = false;
  try {
    const b = JSON.parse(event.body || "{}");
    all = b.all === true;
    ids = Array.isArray(b.ids) ? b.ids.filter((x: unknown): x is string => typeof x === "string").slice(0, 200) : [];
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!all && ids.length === 0) return jsonResponse(400, { error: "ids або all обов'язкові" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });

  let query = supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("org_id", profile.org_id)
    .is("read_at", null);
  if (!all) query = query.in("id", ids);
  const { error } = await query;
  if (error) {
    console.error("mark-notifications-read: update failed", error);
    return jsonResponse(500, { error: "Не вдалося позначити прочитаними" });
  }
  return jsonResponse(200, { ok: true });
};
