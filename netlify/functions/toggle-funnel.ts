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
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let funnelId: string | undefined;
  let isActive: boolean | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    funnelId = typeof body.funnelId === "string" ? body.funnelId : undefined;
    isActive = typeof body.isActive === "boolean" ? body.isActive : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!funnelId || typeof isActive !== "boolean") {
    return jsonResponse(400, { error: "funnelId і isActive обов'язкові" });
  }

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request (see CLAUDE.md: org_id scoping).
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }

  const orgId = profile.org_id as string;

  // No exclusivity rule: each lead-gen link names its own funnel_id and
  // entry_node_id explicitly (see telegram-webhook.ts), so any number of
  // funnels can be active for an org at once without ambiguity over which one
  // a given lead enters.
  const { data: updated, error: updateError } = await supabase
    .from("funnels")
    .update({ is_active: isActive })
    .eq("id", funnelId)
    .eq("org_id", orgId)
    .select("id");

  if (updateError) {
    console.error("toggle-funnel: update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося оновити воронку" });
  }
  if (!updated || updated.length === 0) {
    return jsonResponse(404, { error: "Воронку не знайдено" });
  }

  return jsonResponse(200, { ok: true });
};
