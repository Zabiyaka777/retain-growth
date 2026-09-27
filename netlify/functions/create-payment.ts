import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./_shared/activity-log";
import { MonoError, createInvoice, formatUah, getInvoiceStatus, readOrgMonoToken } from "./_shared/monobank";
import { PAYMENT_COLUMNS, applyInvoiceState, type PaymentRow } from "./_shared/payments";

const INTERVAL_LABEL: Record<"week" | "month" | "year", string> = { week: "тиждень", month: "місяць", year: "рік" };

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Plenty for a course or a consultation; anything above is almost certainly a
// typo (an extra zero) rather than a real invoice.
const MAX_AMOUNT_UAH = 500_000;
// A link sent into a chat should stay payable for a while, not the gateway's default 24h.
const VALIDITY_SECONDS = 7 * 24 * 60 * 60;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Payment links through the org's own Plata by Mono account.
 *   create  { threadId, amount (UAH), destination } → invoice + pageUrl for the
 *           manager to send into the chat. The payments row exists before the
 *           gateway call, so a webhook can never arrive for an unknown invoice.
 *   refresh { paymentId } → polls the invoice status (a missed webhook, or
 *           local development where the gateway can't reach us).
 * org_id comes from the session; the thread/payment must belong to it.
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

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  const creds = await readOrgMonoToken(supabase, orgId);
  if (!creds) return jsonResponse(409, { error: "Спершу підключіть Plata by Mono в Налаштуваннях → Інтеграції" });

  if (body.action === "refresh") {
    const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
    const { data: payment } = await supabase
      .from("payments")
      .select(`${PAYMENT_COLUMNS}, invoice_id`)
      .eq("id", paymentId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!payment?.invoice_id) return jsonResponse(404, { error: "Платіж не знайдено" });
    try {
      const state = await getInvoiceStatus(creds.token, payment.invoice_id as string);
      await applyInvoiceState(supabase, payment as PaymentRow, state, "poll");
      const { data: fresh } = await supabase.from("payments").select("*").eq("id", paymentId).single();
      return jsonResponse(200, { ok: true, payment: fresh });
    } catch (err) {
      return jsonResponse(err instanceof MonoError && err.status !== 0 ? 400 : 502, { error: (err as Error).message });
    }
  }

  // action: create
  const threadId = typeof body.threadId === "string" ? body.threadId : "";
  const offerId = typeof body.offerId === "string" ? body.offerId : null;

  const { data: thread } = await supabase.from("threads").select("id, lead_id").eq("id", threadId).eq("org_id", orgId).maybeSingle();
  if (!thread) return jsonResponse(404, { error: "Чат не знайдено" });

  // Catalog offer: amount/destination/currency come from the offers row,
  // never from the client — a tampered request must not be able to claim
  // "this is offer X" while charging a different amount. Manual "довільна
  // сума" (offerId absent) keeps today's behaviour exactly.
  let amount: number;
  let ccy = 980;
  let destination: string;
  let offer: { id: string; name: string; kind: "one_time" | "recurring"; interval: "week" | "month" | "year" | null } | null = null;

  if (offerId) {
    const { data: offerRow } = await supabase.from("offers").select("id, name, price_amount, ccy, kind, interval, is_active").eq("id", offerId).eq("org_id", orgId).maybeSingle();
    if (!offerRow || !offerRow.is_active) return jsonResponse(404, { error: "Оффер не знайдено або він неактивний" });
    amount = offerRow.price_amount as number;
    ccy = offerRow.ccy as number;
    destination = offerRow.name as string;
    offer = { id: offerRow.id as string, name: offerRow.name as string, kind: offerRow.kind as "one_time" | "recurring", interval: offerRow.interval as "week" | "month" | "year" | null };
  } else {
    const amountUah = typeof body.amount === "number" ? body.amount : Number.NaN;
    destination = typeof body.destination === "string" ? body.destination.trim().slice(0, 200) : "";
    if (!Number.isFinite(amountUah) || amountUah < 1 || amountUah > MAX_AMOUNT_UAH) {
      return jsonResponse(400, { error: `Сума має бути від 1 до ${MAX_AMOUNT_UAH.toLocaleString("uk-UA")} грн` });
    }
    if (!destination) return jsonResponse(400, { error: "Вкажіть призначення платежу — його побачить клієнт" });
    amount = Math.round(amountUah * 100);
  }

  const reference = randomUUID().replace(/-/g, "");

  // Recurring offer: a subscription row exists before the invoice does, same
  // "reserve then fulfil" reasoning as the payment row itself — the webhook
  // that tokenizes the card (maybeStoreWalletToken) needs somewhere to
  // attach to the moment it arrives.
  let subscriptionId: string | null = null;
  if (offer?.kind === "recurring" && offer.interval) {
    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .insert({
        org_id: orgId,
        offer_id: offer.id,
        lead_id: thread.lead_id,
        thread_id: thread.id,
        status: "awaiting_card",
        amount,
        ccy,
        interval: offer.interval,
      })
      .select("id")
      .single();
    if (subError || !subscription) {
      console.error("create-payment: subscription insert failed", subError);
      return jsonResponse(500, { error: "Не вдалося створити підписку" });
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
      lead_id: thread.lead_id,
      thread_id: thread.id,
      amount,
      ccy,
      destination,
      status: "created",
      created_by: userData.user.id,
      offer_id: offer?.id ?? null,
      subscription_id: subscriptionId,
    })
    .select("id")
    .single();
  if (insertError || !payment) {
    console.error("create-payment: insert failed", insertError);
    if (subscriptionId) await supabase.from("subscriptions").delete().eq("id", subscriptionId);
    return jsonResponse(500, { error: "Не вдалося створити платіж" });
  }

  const siteUrl = process.env.URL ?? "https://app.retain-growth.ai";
  let invoice;
  try {
    invoice = await createInvoice(creds.token, {
      amount,
      ccy,
      reference,
      destination,
      webHookUrl: `${siteUrl}/.netlify/functions/mono-webhook`,
      validitySeconds: VALIDITY_SECONDS,
      ...(subscriptionId ? { saveCardData: { saveCard: true as const, walletId: subscriptionId } } : {}),
    });
  } catch (err) {
    // Never reached the gateway as a real invoice — drop the placeholder rows.
    await supabase.from("payments").delete().eq("id", payment.id);
    if (subscriptionId) await supabase.from("subscriptions").delete().eq("id", subscriptionId);
    return jsonResponse(err instanceof MonoError && err.status !== 0 ? 400 : 502, { error: (err as Error).message });
  }

  const { data: saved } = await supabase
    .from("payments")
    .update({ invoice_id: invoice.invoiceId, page_url: invoice.pageUrl, updated_at: new Date().toISOString() })
    .eq("id", payment.id)
    .select("*")
    .single();

  if (thread.lead_id) {
    await logLeadActivity(supabase, {
      orgId,
      leadId: thread.lead_id as string,
      actionType: "payment_link_created",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { payment_id: payment.id, amount: formatUah(amount), destination, test_mode: creds.account.test_mode, offer_id: offer?.id ?? null },
    });
  }

  const message =
    offer?.kind === "recurring" && offer.interval
      ? `${destination} — ${formatUah(amount)} грн / ${INTERVAL_LABEL[offer.interval]}\nОплата активує підписку: картка буде збережена для наступних списань. Скасувати можна в будь-який момент.\nОплатити: ${invoice.pageUrl}`
      : `${destination} — ${formatUah(amount)} грн\nОплатити: ${invoice.pageUrl}`;

  return jsonResponse(200, { ok: true, payment: saved, message });
};
