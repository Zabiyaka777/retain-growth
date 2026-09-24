import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { GRAPH_API_VERSION, loadWhatsAppCredential, type GraphErrorBody } from "./_shared/whatsapp";

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

interface NumberStatusResponse extends GraphErrorBody {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
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

  const credential = await loadWhatsAppCredential(supabase, orgId);
  if (!credential) {
    return jsonResponse(404, { error: "WhatsApp не підключено" });
  }

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${credential.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
    { headers: { authorization: `Bearer ${credential.accessToken}` } },
  );
  const data = (await res.json().catch(() => null)) as NumberStatusResponse | null;

  if (!res.ok) {
    console.error("check-whatsapp-connection: number lookup failed", res.status, data);
    return jsonResponse(200, { ok: false, error: data?.error?.message ?? "Номер недоступний" });
  }

  const siteUrl = process.env.URL ?? "";

  return jsonResponse(200, {
    ok: true,
    displayNumber: data?.display_phone_number ?? "",
    verifiedName: data?.verified_name ?? "",
    qualityRating: data?.quality_rating ?? "",
    wabaId: credential.wabaId,
    webhookUrl: siteUrl ? `${siteUrl}/.netlify/functions/whatsapp-webhook/${orgId}` : "",
  });
};
