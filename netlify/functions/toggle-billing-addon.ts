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

/**
 * Enables/disables one billing addon for the caller's org, or updates its
 * quantity while already enabled (used by the "Додаткові менеджери" stepper).
 * A row in org_billing_addons existing at all IS "enabled" — there's no
 * separate boolean, so disabling deletes the row outright.
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

  let addonKey: string | undefined;
  let enabled: boolean | undefined;
  let quantity: number | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    addonKey = typeof body.addonKey === "string" ? body.addonKey : undefined;
    enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    quantity = typeof body.quantity === "number" && Number.isInteger(body.quantity) ? body.quantity : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!addonKey || enabled === undefined) {
    return jsonResponse(400, { error: "addonKey і enabled обов'язкові" });
  }
  if (quantity !== undefined && quantity < 1) {
    return jsonResponse(400, { error: "quantity має бути не менше 1" });
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

  const { data: addon, error: addonError } = await supabase
    .from("billing_addons")
    .select("id")
    .eq("key", addonKey)
    .maybeSingle();
  if (addonError || !addon) {
    return jsonResponse(404, { error: "Модуль не знайдено" });
  }

  if (!enabled) {
    const { error: deleteError } = await supabase
      .from("org_billing_addons")
      .delete()
      .eq("org_id", orgId)
      .eq("addon_id", addon.id);
    if (deleteError) {
      console.error("toggle-billing-addon: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося вимкнути модуль" });
    }
    return jsonResponse(200, { ok: true });
  }

  const { error: upsertError } = await supabase.from("org_billing_addons").upsert(
    {
      org_id: orgId,
      addon_id: addon.id,
      quantity: quantity ?? 1,
    },
    { onConflict: "org_id,addon_id" },
  );

  if (upsertError) {
    console.error("toggle-billing-addon: upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося увімкнути модуль" });
  }

  return jsonResponse(200, { ok: true });
};
