import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { chargeByToken, readOrgMonoToken } from "./_shared/monobank";
import { PAYMENT_COLUMNS, applySubscriptionRenewalOutcome, type PaymentRow } from "./_shared/payments";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CLAIM_BATCH_SIZE = 200;

/**
 * Scheduled (netlify.toml, once a day): charges every subscription whose
 * next_charge_at is due, via Monobank's "Оплата по токену"
 * (POST /api/merchant/wallet/payment, initiationKind:'merchant' — the
 * customer isn't present). claim_due_subscriptions leases each row (10 min,
 * "for update skip locked") so two overlapping runs can't double-charge.
 *
 * Same reserve-then-fulfil shape as create-payment.ts: the `payments` row
 * exists before the gateway call, so mono-webhook.ts never receives a report
 * for an invoice it doesn't recognise. `is_subscription_charge: true` is
 * what tells applySubscriptionRenewalOutcome this payment is a renewal, not
 * a subscription's first invoice (see the migration comment on that column).
 */
export const handler: Handler = async () => {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_due_subscriptions", { p_limit: CLAIM_BATCH_SIZE });
  if (claimError) {
    console.error("charge-subscriptions: claim_due_subscriptions failed", claimError);
    return { statusCode: 500, body: "claim failed" };
  }

  const siteUrl = process.env.URL;
  const subscriptions = (claimed ?? []) as {
    id: string;
    org_id: string;
    offer_id: string;
    lead_id: string;
    thread_id: string | null;
    amount: number;
    ccy: number;
    interval: "week" | "month" | "year";
    card_token_secret_id: string;
  }[];

  let charged = 0;
  for (const sub of subscriptions) {
    try {
      const [{ data: cardToken }, creds, { data: offer }] = await Promise.all([
        supabase.rpc("vault_read_secret", { secret_id: sub.card_token_secret_id }),
        readOrgMonoToken(supabase, sub.org_id),
        supabase.from("offers").select("name").eq("id", sub.offer_id).maybeSingle(),
      ]);

      if (!cardToken) {
        console.error("charge-subscriptions: failed to decrypt card token", sub.id);
        continue; // stays claimed for 10 min, then falls due again for the next daily run
      }
      if (!creds) {
        console.error("charge-subscriptions: org has no Plata by Mono account", sub.org_id);
        continue;
      }

      const destination = (offer?.name as string | undefined) ?? "Підписка";
      const reference = randomUUID().replace(/-/g, "");

      const { data: payment, error: insertError } = await supabase
        .from("payments")
        .insert({
          org_id: sub.org_id,
          provider: "monobank",
          test_mode: creds.account.test_mode,
          reference,
          lead_id: sub.lead_id,
          thread_id: sub.thread_id,
          amount: sub.amount,
          ccy: sub.ccy,
          destination,
          status: "created",
          offer_id: sub.offer_id,
          subscription_id: sub.id,
          is_subscription_charge: true,
        })
        .select(PAYMENT_COLUMNS)
        .single();
      if (insertError || !payment) {
        console.error("charge-subscriptions: payment insert failed", sub.id, insertError);
        continue;
      }

      let result;
      try {
        result = await chargeByToken(creds.token, {
          cardToken: String(cardToken),
          amount: sub.amount,
          ccy: sub.ccy,
          reference,
          destination,
          initiationKind: "merchant",
          ...(siteUrl ? { webHookUrl: `${siteUrl}/.netlify/functions/mono-webhook` } : {}),
        });
      } catch (err) {
        console.error("charge-subscriptions: chargeByToken failed", sub.id, err);
        await supabase.from("payments").update({ status: "failure", failure_reason: (err as Error).message, updated_at: new Date().toISOString() }).eq("id", payment.id);
        await applySubscriptionRenewalOutcome(supabase, { ...(payment as PaymentRow), status: "failure" }, "failure");
        continue;
      }

      await supabase.from("payments").update({ invoice_id: result.invoiceId, status: result.status, updated_at: new Date().toISOString() }).eq("id", payment.id);
      charged++;

      // A merchant-initiated, card-not-present charge typically resolves
      // synchronously (no 3DS to wait for) — settle the outcome right away
      // when it does. If Monobank instead leaves it 'processing', the
      // webhook this call passed above resolves it later through the same
      // applySubscriptionRenewalOutcome call in mono-webhook.ts.
      if (result.status === "success" || result.status === "failure" || result.status === "reversed") {
        await applySubscriptionRenewalOutcome(supabase, { ...(payment as PaymentRow), status: result.status }, result.status);
      }
    } catch (err) {
      console.error("charge-subscriptions: unhandled error", sub.id, err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ claimed: subscriptions.length, charged }) };
};
