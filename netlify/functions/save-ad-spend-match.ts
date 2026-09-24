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

  let rowId: string | undefined;
  let linkId: string | null | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    rowId = typeof body.rowId === "string" ? body.rowId : undefined;
    linkId = body.linkId === null ? null : typeof body.linkId === "string" ? body.linkId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!rowId || linkId === undefined) {
    return jsonResponse(400, { error: "rowId і linkId обов'язкові (linkId може бути null)" });
  }

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

  // Confirms the chosen link is actually this org's before attaching it — a
  // plain .eq("org_id", orgId) on the row update below already keeps the
  // *row* scoped, but linkId comes from the client and needs its own check.
  if (linkId) {
    const { data: link, error: linkError } = await supabase
      .from("lead_gen_links")
      .select("id")
      .eq("id", linkId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (linkError || !link) {
      return jsonResponse(404, { error: "Посилання не знайдено" });
    }
  }

  const { data: row, error: updateError } = await supabase
    .from("ad_spend_rows")
    .update({ matched_link_id: linkId })
    .eq("id", rowId)
    .eq("org_id", orgId)
    .select("id, matched_link_id")
    .maybeSingle();

  if (updateError) {
    console.error("save-ad-spend-match: update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося зберегти зіставлення" });
  }
  if (!row) {
    return jsonResponse(404, { error: "Рядок не знайдено" });
  }

  return jsonResponse(200, { ok: true, row });
};
