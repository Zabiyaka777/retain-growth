import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { MonoError, getMerchantDetails, getWebhookPubkey, readOrgMonoToken } from "./_shared/monobank";

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

const ACCOUNT_COLUMNS = "id, provider, test_mode, merchant_id, merchant_name, edrpou, verified_at, created_at, updated_at";

/**
 * The caller org's own Plata by Mono account (accepting payments from its
 * leads). org_id always comes from the session, never the body.
 *   save        { token, testMode } — verified against monobank before
 *                anything is stored; the token goes to Vault only
 *   verify      re-checks the stored token (/api/merchant/details)
 *   set_test_mode { testMode }
 *   disconnect  removes the account and its Vault secret; payments history stays
 * The token is never returned to the browser.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  const action = body.action;

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  if (action === "save") {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const testMode = body.testMode === true;
    // Mono tokens are long base64-ish strings; this only rejects obvious paste
    // accidents — the real check is monobank accepting it below.
    if (!/^[A-Za-z0-9_\-+/=]{20,200}$/.test(token)) return jsonResponse(400, { error: "Схоже, це не токен monobank — скопіюйте його повністю, без пробілів" });

    let merchant;
    let pubkey;
    try {
      merchant = await getMerchantDetails(token);
      pubkey = await getWebhookPubkey(token);
    } catch (err) {
      const status = err instanceof MonoError && (err.status === 401 || err.status === 403) ? 400 : 502;
      return jsonResponse(status, { error: (err as Error).message });
    }

    const { data: secretId, error: secretError } = await supabase.rpc("vault_create_secret", {
      secret: token,
      name: `monobank_token_${orgId}_${Date.now()}`,
      description: `Plata by Mono token for org ${orgId}`,
    });
    if (secretError || !secretId) {
      console.error("payment-account: vault_create_secret failed", secretError);
      return jsonResponse(500, { error: "Не вдалося безпечно зберегти токен" });
    }

    const { data: existing } = await supabase
      .from("org_payment_accounts")
      .select("token_secret_id")
      .eq("org_id", orgId)
      .eq("provider", "monobank")
      .maybeSingle();

    const now = new Date().toISOString();
    const { data: account, error: upsertError } = await supabase
      .from("org_payment_accounts")
      .upsert(
        {
          org_id: orgId,
          provider: "monobank",
          token_secret_id: secretId,
          test_mode: testMode,
          merchant_id: merchant.merchantId,
          merchant_name: merchant.merchantName,
          edrpou: merchant.edrpou,
          webhook_pubkey: pubkey,
          verified_at: now,
          updated_at: now,
        },
        { onConflict: "org_id,provider" },
      )
      .select(ACCOUNT_COLUMNS)
      .single();
    if (upsertError) {
      console.error("payment-account: upsert failed", upsertError);
      await supabase.rpc("vault_delete_secret", { secret_id: secretId });
      return jsonResponse(500, { error: "Не вдалося зберегти підключення" });
    }
    // Only after the row points at the new secret is the old one released.
    if (existing?.token_secret_id) await supabase.rpc("vault_delete_secret", { secret_id: existing.token_secret_id });

    await supabase.from("events").insert({
      org_id: orgId,
      type: "payment_account_connected",
      level: "info",
      payload: { provider: "monobank", merchant_id: merchant.merchantId, test_mode: testMode, by: userData.user.email ?? null },
    });
    return jsonResponse(200, { ok: true, account });
  }

  if (action === "verify") {
    const creds = await readOrgMonoToken(supabase, orgId);
    if (!creds) return jsonResponse(404, { error: "Plata by Mono ще не підключено" });
    try {
      const merchant = await getMerchantDetails(creds.token);
      const { data: account } = await supabase
        .from("org_payment_accounts")
        .update({ merchant_id: merchant.merchantId, merchant_name: merchant.merchantName, edrpou: merchant.edrpou, verified_at: new Date().toISOString() })
        .eq("id", creds.account.id)
        .select(ACCOUNT_COLUMNS)
        .single();
      return jsonResponse(200, { ok: true, account });
    } catch (err) {
      return jsonResponse(err instanceof MonoError && err.status !== 0 ? 400 : 502, { error: (err as Error).message });
    }
  }

  if (action === "set_test_mode") {
    const { data: account, error } = await supabase
      .from("org_payment_accounts")
      .update({ test_mode: body.testMode === true, updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("provider", "monobank")
      .select(ACCOUNT_COLUMNS)
      .maybeSingle();
    if (error) return jsonResponse(500, { error: "Не вдалося змінити режим" });
    if (!account) return jsonResponse(404, { error: "Plata by Mono ще не підключено" });
    return jsonResponse(200, { ok: true, account });
  }

  if (action === "disconnect") {
    const { data: existing } = await supabase
      .from("org_payment_accounts")
      .select("id, token_secret_id")
      .eq("org_id", orgId)
      .eq("provider", "monobank")
      .maybeSingle();
    if (!existing) return jsonResponse(200, { ok: true });
    const { error } = await supabase.from("org_payment_accounts").delete().eq("id", existing.id);
    if (error) return jsonResponse(500, { error: "Не вдалося відключити" });
    await supabase.rpc("vault_delete_secret", { secret_id: existing.token_secret_id });
    await supabase.from("events").insert({
      org_id: orgId,
      type: "payment_account_disconnected",
      level: "info",
      payload: { provider: "monobank", by: userData.user.email ?? null },
    });
    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(400, { error: "Невідома дія" });
};
