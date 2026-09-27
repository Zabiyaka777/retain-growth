import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { getWebhookPubkey, readOrgMonoToken, verifyMonoSignature, type MonoInvoiceState } from "./_shared/monobank";
import { PAYMENT_COLUMNS, applyInvoiceState, type PaymentRow } from "./_shared/payments";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const text = (statusCode: number, body = "") => ({ statusCode, headers: { "content-type": "text/plain" }, body });

/**
 * Plata by Mono payment-status webhook (the webHookUrl create-payment.ts puts
 * on every invoice). Public, so nothing in the body is trusted until X-Sign —
 * an ECDSA signature over the exact raw body — verifies against the merchant's
 * public key. The merchant is found through our own payments row
 * (invoiceId → org), never through anything the caller claims.
 *
 * monobank retries up to 3 times until it gets a 200, so every verified
 * delivery answers 200 — including stale or duplicate ones, which
 * applyInvoiceState simply ignores.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return text(405);

  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : Buffer.from(event.body ?? "", "utf8");
  const xSign = event.headers["x-sign"] ?? event.headers["X-Sign"];
  if (!xSign || raw.length === 0 || raw.length > 64 * 1024) return text(400);

  let state: MonoInvoiceState;
  try {
    state = JSON.parse(raw.toString("utf8"));
  } catch {
    return text(400);
  }
  if (typeof state.invoiceId !== "string" || !state.invoiceId) return text(400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: payment } = await supabase
    .from("payments")
    .select(`${PAYMENT_COLUMNS}, reference`)
    .eq("invoice_id", state.invoiceId)
    .maybeSingle();
  // Not ours (or already removed with its org) — nothing to verify against.
  if (!payment) return text(404);

  const { data: account } = await supabase
    .from("org_payment_accounts")
    .select("id, webhook_pubkey")
    .eq("org_id", payment.org_id)
    .eq("provider", "monobank")
    .maybeSingle();
  if (!account) {
    await supabase.from("events").insert({
      org_id: payment.org_id,
      type: "payment_webhook_no_account",
      level: "warn",
      payload: { invoice_id: state.invoiceId, status: state.status },
    });
    return text(409);
  }

  let verified = !!account.webhook_pubkey && verifyMonoSignature(account.webhook_pubkey, raw, xSign);
  if (!verified) {
    // The key rotates rarely; on a miss fetch the current one once and retry.
    const creds = await readOrgMonoToken(supabase, payment.org_id as string);
    if (creds) {
      try {
        const fresh = await getWebhookPubkey(creds.token);
        if (fresh !== account.webhook_pubkey) {
          verified = verifyMonoSignature(fresh, raw, xSign);
          if (verified) await supabase.from("org_payment_accounts").update({ webhook_pubkey: fresh }).eq("id", account.id);
        }
      } catch (err) {
        console.error("mono-webhook: pubkey refresh failed", err);
      }
    }
  }
  if (!verified) {
    await supabase.from("events").insert({
      org_id: payment.org_id,
      type: "payment_webhook_bad_signature",
      level: "error",
      payload: { invoice_id: state.invoiceId },
    });
    return text(401);
  }

  // Signed, but it must also be about this very payment.
  if (state.reference && state.reference !== payment.reference) return text(200);

  await applyInvoiceState(supabase, payment as PaymentRow, state, "webhook");
  return text(200, "ok");
};
