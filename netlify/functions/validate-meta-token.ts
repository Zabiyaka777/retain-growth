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
// Same version meta-capi-send.ts sends real events against.
const GRAPH_API_VERSION = "v19.0";

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface GraphPixelResponse {
  id?: string;
  error?: { message?: string };
}

// Pure read-only check, no DB writes: lets LeadGenLinkForm.tsx show a live
// valid/invalid indicator on the token field before the link is ever saved.
// Same probe the removed connect-meta.ts used — a GET on the pixel itself
// (not /me) confirms the token can see THIS pixel, not just that it's valid
// for something.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let token: string | undefined;
  let pixelId: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    token = typeof body.token === "string" ? body.token.trim() : undefined;
    pixelId = typeof body.pixelId === "string" ? body.pixelId.trim() : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!token || !pixelId) {
    return jsonResponse(400, { error: "token і pixelId обов'язкові" });
  }

  // No org-scoped data is touched here — this is a stateless probe against
  // Meta — but the session check still stops this function being used as an
  // open, unauthenticated proxy to hammer Graph API.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  try {
    // The token goes in the Authorization header, never the query string —
    // Graph API accepts a Bearer token the same as access_token=..., but a
    // query param would land in any request logging along the way.
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}?fields=id`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as GraphPixelResponse;

    if (res.ok && data.id) {
      return jsonResponse(200, { valid: true });
    }
    return jsonResponse(200, { valid: false, error: data.error?.message ?? "Токен не має доступу до цього пікселя" });
  } catch (err) {
    console.error("validate-meta-token: Graph API request failed", err);
    return jsonResponse(200, { valid: false, error: "Мережева помилка під час перевірки" });
  }
};
