import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { GRAPH_API_VERSION } from "./_shared/instagram";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface GraphErrorBody {
  error?: { message?: string };
}

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

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }
  const orgId = profile.org_id as string;

  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("access_token_secret_id, instagram_business_account_id, page_id")
    .eq("org_id", orgId)
    .eq("channel_type", "instagram")
    .maybeSingle();

  if (credentialError || !credential) {
    return jsonResponse(404, { error: "Instagram не підключено" });
  }

  const { data: pageAccessToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.access_token_secret_id,
  });
  if (tokenError || !pageAccessToken) {
    console.error("check-instagram-connection: vault_read_secret failed", tokenError);
    return jsonResponse(500, { error: "Не вдалося розшифрувати токен" });
  }

  const [pageRes, igRes] = await Promise.all([
    fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${credential.page_id}?fields=name&access_token=${encodeURIComponent(pageAccessToken as string)}`),
    fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${credential.instagram_business_account_id}?fields=username&access_token=${encodeURIComponent(pageAccessToken as string)}`),
  ]);
  const pageData = (await pageRes.json().catch(() => null)) as ({ name?: string } & GraphErrorBody) | null;
  const igData = (await igRes.json().catch(() => null)) as ({ username?: string } & GraphErrorBody) | null;

  if (!pageRes.ok || !igRes.ok) {
    console.error("check-instagram-connection: Graph API check failed", pageData, igData);
    return jsonResponse(200, { ok: false, error: pageData?.error?.message ?? igData?.error?.message ?? "Instagram недоступний" });
  }

  return jsonResponse(200, {
    ok: true,
    pageName: pageData?.name ?? "",
    instagramUsername: igData?.username ?? "",
  });
};
