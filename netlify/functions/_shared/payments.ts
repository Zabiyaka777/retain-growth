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
}

export const PAYMENT_COLUMNS = "id, org_id, lead_id, status, amount, destination, test_mode, provider_modified_at, paid_at";

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
