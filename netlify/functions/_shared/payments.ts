import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./activity-log";
import { maybeSendStageConversion } from "./stage-conversion";
import { MONO_STATUSES, MonoError, createInvoice, formatUah, readOrgMonoToken, type MonoInvoiceState } from "./monobank";

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

  let query = supabase
    .from("payments")
    .update({
      status: state.status,
      final_amount: typeof state.finalAmount === "number" ? state.finalAmount : null,
      failure_reason: state.failureReason ?? null,
      err_code: state.errCode ? String(state.errCode) : null,
      provider_modified_at: modifiedAt,
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

  const paidAmount = typeof state.finalAmount === "number" && state.finalAmount > 0 ? state.finalAmount : payment.amount;

  // «Paid» happens exactly once per payment, even when monobank delivers the
  // success twice at the same moment: setting paid_at only where it's still
  // null is the atomic claim, and only the delivery that wins it logs the
  // payment and moves the lead.
  if (state.status === "success") {
    const { data: claimed } = await supabase
      .from("payments")
      .update({ paid_at: modifiedAt })
      .eq("id", payment.id)
      .is("paid_at", null)
      .select("id");
    if (claimed && claimed.length > 0 && payment.lead_id) {
      await logLeadActivity(supabase, {
        orgId: payment.org_id,
        leadId: payment.lead_id,
        actionType: "payment_success",
        actorType: "system",
        details: { payment_id: payment.id, amount: formatUah(paidAmount), destination: payment.destination, test_mode: payment.test_mode, source },
      });
      // A real (non-test) payment is a sale: same path as a manager setting
      // «Продажа» by hand (save-lead-stage.ts) — history entry with the paid
      // sum, current stage, activity line and the stage's Meta conversion.
      if (!payment.test_mode) await moveLeadToSale(supabase, payment, paidAmount, modifiedAt);
    }
    return true;
  }

  if (payment.lead_id && ((state.status === "failure" && payment.status !== "failure") || (state.status === "reversed" && payment.status !== "reversed"))) {
    await logLeadActivity(supabase, {
      orgId: payment.org_id,
      leadId: payment.lead_id,
      actionType: state.status === "failure" ? "payment_failed" : "payment_reversed",
      actorType: "system",
      details: {
        payment_id: payment.id,
        amount: formatUah(paidAmount),
        destination: payment.destination,
        test_mode: payment.test_mode,
        failure_reason: state.failureReason ?? null,
        source,
      },
    });
  }
  return true;
}

async function moveLeadToSale(supabase: SupabaseClient, payment: PaymentRow, amountMinor: number, paidAt: string): Promise<void> {
  if (!payment.lead_id) return;
  const { data: saleStage } = await supabase.from("funnel_stages").select("id, name").is("org_id", null).eq("name", "Продажа").maybeSingle();
  if (!saleStage) {
    console.error("payments: built-in «Продажа» stage not found");
    return;
  }
  const { data: lead } = await supabase.from("leads").select("current_stage_id").eq("id", payment.lead_id).eq("org_id", payment.org_id).maybeSingle();
  if (!lead) return;

  // Stage values are plain sums (the manager types them in UAH-or-base by
  // hand); monobank invoices are always in hryvnias.
  const value = Math.round(amountMinor) / 100;
  const { data: historyRow, error: historyError } = await supabase
    .from("lead_stage_history")
    .insert({ org_id: payment.org_id, lead_id: payment.lead_id, stage_id: saleStage.id, value, entered_at: paidAt })
    .select("id, entered_at")
    .single();
  if (historyError || !historyRow) {
    console.error("payments: sale stage history insert failed", payment.id, historyError);
    return;
  }
  const { error: updateError } = await supabase.from("leads").update({ current_stage_id: saleStage.id }).eq("id", payment.lead_id).eq("org_id", payment.org_id);
  if (updateError) console.error("payments: current_stage_id update failed", payment.id, updateError);

  const { data: fromStage } = lead.current_stage_id
    ? await supabase.from("funnel_stages").select("name").eq("id", lead.current_stage_id).maybeSingle()
    : { data: null };
  await logLeadActivity(supabase, {
    orgId: payment.org_id,
    leadId: payment.lead_id,
    actionType: "stage_changed",
    actorType: "system",
    details: { from_stage: (fromStage?.name as string | undefined) ?? null, to_stage: saleStage.name, value, via: "payment", payment_id: payment.id },
  });
  await maybeSendStageConversion(supabase, {
    historyId: historyRow.id as string,
    orgId: payment.org_id,
    leadId: payment.lead_id,
    stageId: saleStage.id as string,
    value,
    enteredAt: historyRow.entered_at as string,
  });
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

const OFFER_INVOICE_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

export interface OfferInvoiceResult {
  ok: boolean;
  paymentId?: string;
  pageUrl?: string;
  offerName?: string;
  amount?: number;
  ccy?: number;
  kind?: "one_time" | "recurring";
  interval?: "week" | "month" | "year" | null;
  error?: string;
}

/**
 * The offer-catalog counterpart of create-payment.ts's "action: create" —
 * factored out here (rather than duplicated) so both a chat-side caller and
 * _shared/funnel-graph.ts's 'offer' node create invoices the exact same way:
 * amount/currency/name always come from the offers row itself, a recurring
 * offer gets a subscriptions row before the invoice (same reserve-then-
 * fulfil shape payments rows already follow), and saveCardData is attached
 * automatically when it's recurring.
 *
 * `funnelStateId`, when given, is stamped on the payments row so
 * mono-webhook.ts knows which parked 'offer' node to resume on success —
 * chat-side callers simply omit it.
 */
export async function createOfferInvoice(
  supabase: SupabaseClient,
  params: { orgId: string; offerId: string; leadId: string | null; threadId: string | null; funnelStateId?: string | null; siteUrl: string },
): Promise<OfferInvoiceResult> {
  const { orgId, offerId, leadId, threadId, funnelStateId, siteUrl } = params;

  const creds = await readOrgMonoToken(supabase, orgId);
  if (!creds) return { ok: false, error: "Plata by Mono не підключено" };

  const { data: offerRow } = await supabase.from("offers").select("id, name, price_amount, ccy, kind, interval, is_active").eq("id", offerId).eq("org_id", orgId).maybeSingle();
  if (!offerRow || !offerRow.is_active) return { ok: false, error: "Оффер не знайдено або він неактивний" };

  const amount = offerRow.price_amount as number;
  const ccy = offerRow.ccy as number;
  const destination = offerRow.name as string;
  const kind = offerRow.kind as "one_time" | "recurring";
  const interval = offerRow.interval as "week" | "month" | "year" | null;
  const reference = randomUUID().replace(/-/g, "");

  let subscriptionId: string | null = null;
  if (kind === "recurring" && interval) {
    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .insert({ org_id: orgId, offer_id: offerId, lead_id: leadId, thread_id: threadId, funnel_state_id: funnelStateId ?? null, status: "awaiting_card", amount, ccy, interval })
      .select("id")
      .single();
    if (subError || !subscription) {
      console.error("createOfferInvoice: subscription insert failed", subError);
      return { ok: false, error: "Не вдалося створити підписку" };
    }
    subscriptionId = subscription.id as string;
  }

  const { data: payment, error: insertError } = await supabase
    .from("payments")
    .insert({
      org_id: orgId,
      provider: "monobank",
      test_mode: creds.account.test_mode,
      reference,
      lead_id: leadId,
      thread_id: threadId,
      funnel_state_id: funnelStateId ?? null,
      amount,
      ccy,
      destination,
      status: "created",
      offer_id: offerId,
      subscription_id: subscriptionId,
    })
    .select("id")
    .single();
  if (insertError || !payment) {
    console.error("createOfferInvoice: payment insert failed", insertError);
    if (subscriptionId) await supabase.from("subscriptions").delete().eq("id", subscriptionId);
    return { ok: false, error: "Не вдалося створити платіж" };
  }

  try {
    const invoice = await createInvoice(creds.token, {
      amount,
      ccy,
      reference,
      destination,
      webHookUrl: `${siteUrl}/.netlify/functions/mono-webhook`,
      validitySeconds: OFFER_INVOICE_VALIDITY_SECONDS,
      ...(subscriptionId ? { saveCardData: { saveCard: true as const, walletId: subscriptionId } } : {}),
    });
    await supabase.from("payments").update({ invoice_id: invoice.invoiceId, page_url: invoice.pageUrl, updated_at: new Date().toISOString() }).eq("id", payment.id);
    return { ok: true, paymentId: payment.id as string, pageUrl: invoice.pageUrl, offerName: destination, amount, ccy, kind, interval };
  } catch (err) {
    await supabase.from("payments").delete().eq("id", payment.id);
    if (subscriptionId) await supabase.from("subscriptions").delete().eq("id", subscriptionId);
    console.error("createOfferInvoice: createInvoice failed", err);
    return { ok: false, error: err instanceof MonoError ? err.message : "monobank не відповідає" };
  }
}
