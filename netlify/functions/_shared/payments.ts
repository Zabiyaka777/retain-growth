import type { SupabaseClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./activity-log";
import { MONO_STATUSES, formatUah, type MonoInvoiceState } from "./monobank";

export interface PaymentRow {
  id: string;
  org_id: string;
  lead_id: string | null;
  status: string;
  amount: number;
  destination: string | null;
  test_mode: boolean;
  provider_modified_at: string | null;
  paid_at: string | null;
  subscription_id: string | null;
  is_subscription_charge: boolean;
}

export const PAYMENT_COLUMNS =
  "id, org_id, lead_id, status, amount, destination, test_mode, provider_modified_at, paid_at, subscription_id, is_subscription_charge";

const INTERVAL_MS: Record<"week" | "month" | "year", number> = {
  week: 7 * 24 * 60 * 60 * 1000,
  // Approximated in days rather than calendar months/years — simple, and the
  // few days of drift per cycle don't matter for a billing reminder cadence.
  // Revisit with real calendar-month math if that precision ever matters.
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

export function nextChargeDate(from: Date, interval: "week" | "month" | "year"): Date {
  return new Date(from.getTime() + INTERVAL_MS[interval]);
}

/**
 * Reacts to the card-tokenization half of a Monobank webhook/poll report —
 * independent of the invoice's own payment status (see the docs quote on
 * CreateInvoiceInput.saveCardData: a card-status change fires its own
 * webhook delivery, separate from "the invoice was paid"). Only relevant
 * when this payment belongs to a subscription's first invoice.
 *
 * Stores the card token in Vault (same pattern as channel_credentials'
 * bot_token_secret_id), flips the subscription to 'active', and schedules
 * the first renewal. Safe to call on every report — a repeat call with the
 * same cardToken just re-upserts the same secret's replacement, harmless.
 */
export async function maybeStoreWalletToken(supabase: SupabaseClient, payment: PaymentRow, state: MonoInvoiceState): Promise<void> {
  const cardToken = state.walletData?.cardToken;
  if (!cardToken || !payment.subscription_id) return;

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, org_id, interval, card_token_secret_id, status")
    .eq("id", payment.subscription_id)
    .maybeSingle();
  if (!subscription || subscription.status === "canceled") return;

  const { data: secretId, error: secretError } = await supabase.rpc("vault_create_secret", {
    secret: cardToken,
    name: `mono_card_token_${subscription.id}_${Date.now()}`,
    description: "Monobank tokenized card (subscription renewal)",
  });
  if (secretError || !secretId) {
    console.error("payments: vault_create_secret (card token) failed", secretError);
    return;
  }

  const { error: updateError } = await supabase
    .from("subscriptions")
    .update({
      status: "active",
      card_token_secret_id: secretId,
      wallet_id: state.walletData?.walletId ?? null,
      next_charge_at: nextChargeDate(new Date(), subscription.interval as "week" | "month" | "year").toISOString(),
    })
    .eq("id", subscription.id);
  if (updateError) console.error("payments: subscription activation update failed", updateError);

  // The now-superseded old token (a retry/reconnect scenario) is released
  // only after the row stops pointing at it — same FK-safe ordering
  // connect-telegram.ts uses for bot_token_secret_id.
  if (subscription.card_token_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: subscription.card_token_secret_id });
    if (error) console.error("payments: vault_delete_secret (old card token) failed", error);
  }
}

/**
 * Applies one gateway report (webhook or a status poll) to a payments row.
 * Monobank retries webhooks and doesn't promise their order, so a report
 * older than the last one applied (by the gateway's own modifiedDate) is
 * dropped, and the conditional update makes two concurrent deliveries of the
 * same report harmless. Returns whether anything changed.
 */
export async function applyInvoiceState(
  supabase: SupabaseClient,
  payment: PaymentRow,
  state: MonoInvoiceState,
  source: "webhook" | "poll",
): Promise<boolean> {
  if (!MONO_STATUSES.includes(state.status)) return false;
  const modifiedAt = state.modifiedDate ? new Date(state.modifiedDate).toISOString() : new Date().toISOString();
  if (payment.provider_modified_at && Date.parse(payment.provider_modified_at) > Date.parse(modifiedAt)) return false;

  const becamePaid = state.status === "success" && payment.status !== "success";
  let query = supabase
    .from("payments")
    .update({
      status: state.status,
      final_amount: typeof state.finalAmount === "number" ? state.finalAmount : null,
      failure_reason: state.failureReason ?? null,
      err_code: state.errCode ? String(state.errCode) : null,
      provider_modified_at: modifiedAt,
      paid_at: state.status === "success" ? (payment.paid_at ?? modifiedAt) : payment.paid_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payment.id);
  query = payment.provider_modified_at ? query.lte("provider_modified_at", modifiedAt) : query.is("provider_modified_at", null);
  const { data, error } = await query.select("id");
  if (error) {
    console.error("payments: status update failed", payment.id, error);
    return false;
  }
  if (!data || data.length === 0) return false; // a newer report won the race

  if (payment.lead_id && (becamePaid || (state.status === "failure" && payment.status !== "failure") || (state.status === "reversed" && payment.status !== "reversed"))) {
    await logLeadActivity(supabase, {
      orgId: payment.org_id,
      leadId: payment.lead_id,
      actionType: state.status === "success" ? "payment_success" : state.status === "failure" ? "payment_failed" : "payment_reversed",
      actorType: "system",
      details: {
        payment_id: payment.id,
        amount: formatUah(typeof state.finalAmount === "number" && state.finalAmount > 0 ? state.finalAmount : payment.amount),
        destination: payment.destination,
        test_mode: payment.test_mode,
        failure_reason: state.failureReason ?? null,
        source,
      },
    });
  }
  return true;
}

// Deflects the first N-1 failed renewals back into a retry rather than
// giving up on the first declined card (an expired-but-about-to-be-replaced
// card, a momentary bank-side hiccup) — same "don't escalate on the first
// miss" reasoning ai-respond.ts's report_error threshold uses.
const MAX_CHARGE_ATTEMPTS = 3;

/**
 * Only for a renewal charge (payment.is_subscription_charge === true) — the
 * subscription's own first invoice is handled by maybeStoreWalletToken
 * instead, which is why this checks the flag rather than just
 * subscription_id (both kinds of payment carry it). Call this after
 * applyInvoiceState (or immediately after a synchronous chargeByToken
 * response) with the same final status.
 *
 * Success: advances next_charge_at to the next cycle and clears the retry
 * counter. Failure: counts the attempt; past MAX_CHARGE_ATTEMPTS the
 * subscription moves to 'past_due' (stops being picked up by
 * claim_due_subscriptions) and a manager-visible activity entry is logged —
 * same pattern as ai-respond.ts's ai_reply_failed, never silent.
 */
export async function applySubscriptionRenewalOutcome(supabase: SupabaseClient, payment: PaymentRow, status: MonoInvoiceState["status"]): Promise<void> {
  if (!payment.is_subscription_charge || !payment.subscription_id) return;
  if (status !== "success" && status !== "failure" && status !== "reversed") return; // still in flight — wait for the next report

  const { data: subscription } = await supabase.from("subscriptions").select("id, org_id, lead_id, interval, failed_charge_attempts, status").eq("id", payment.subscription_id).maybeSingle();
  if (!subscription || subscription.status !== "active") return;

  if (status === "success") {
    const { error } = await supabase
      .from("subscriptions")
      .update({ next_charge_at: nextChargeDate(new Date(), subscription.interval as "week" | "month" | "year").toISOString(), failed_charge_attempts: 0 })
      .eq("id", subscription.id);
    if (error) console.error("payments: subscription renewal advance failed", error);
    return;
  }

  const attempts = (subscription.failed_charge_attempts ?? 0) + 1;
  const pastDue = attempts >= MAX_CHARGE_ATTEMPTS;
  const { error } = await supabase
    .from("subscriptions")
    .update({ failed_charge_attempts: attempts, status: pastDue ? "past_due" : "active" })
    .eq("id", subscription.id);
  if (error) console.error("payments: subscription renewal failure update failed", error);

  if (subscription.lead_id && pastDue) {
    await logLeadActivity(supabase, {
      orgId: subscription.org_id,
      leadId: subscription.lead_id,
      actionType: "subscription_past_due",
      actorType: "system",
      details: { subscription_id: subscription.id, attempts, payment_id: payment.id },
    });
  }
}
