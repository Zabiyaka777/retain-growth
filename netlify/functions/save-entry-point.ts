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

const VALID_CHANNEL_TYPES = ["telegram", "fbm", "whatsapp"];

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

  let channelType: string | undefined;
  let name: string | undefined;
  let adRefPattern: string | null = null;
  let targetFunnelId: string | null = null;
  try {
    const body = JSON.parse(event.body || "{}");
    channelType = typeof body.channelType === "string" ? body.channelType : undefined;
    name = typeof body.name === "string" ? body.name.trim() : undefined;
    adRefPattern = typeof body.adRefPattern === "string" && body.adRefPattern.trim() ? body.adRefPattern.trim() : null;
    targetFunnelId = typeof body.targetFunnelId === "string" ? body.targetFunnelId : null;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!channelType || !VALID_CHANNEL_TYPES.includes(channelType)) {
    return jsonResponse(400, { error: "Некоректний канал" });
  }
  if (!name) {
    return jsonResponse(400, { error: "Назва обов'язкова" });
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

  if (targetFunnelId) {
    const { data: funnel, error: funnelError } = await supabase
      .from("funnels")
      .select("id")
      .eq("id", targetFunnelId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (funnelError || !funnel) {
      return jsonResponse(404, { error: "Воронку не знайдено" });
    }
  }

  const { data: entryPoint, error: insertError } = await supabase
    .from("entry_points")
    .insert({
      org_id: orgId,
      channel_type: channelType,
      name,
      ad_ref_pattern: adRefPattern,
      target_funnel_id: targetFunnelId,
    })
    .select("id, channel_type, name, ad_ref_pattern, target_funnel_id, created_at")
    .single();

  if (insertError || !entryPoint) {
    console.error("save-entry-point: insert failed", insertError);
    return jsonResponse(500, { error: "Не вдалося створити точку входу" });
  }

  return jsonResponse(200, { ok: true, entryPoint });
};
