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
}

export const PAYMENT_COLUMNS = "id, org_id, lead_id, status, amount, destination, test_mode, provider_modified_at, paid_at, subscription_id";

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
