import { createVerify } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Plata by Mono (monobank acquiring) — https://api.monobank.ua/docs/acquiring.html
// One credential only: the merchant's X-Token (web.monobank.ua → acquiring,
// or a test token from api.monobank.ua — same API, no real money).

const MONO_API = "https://api.monobank.ua";
const TIMEOUT_MS = 10_000;

export type MonoInvoiceStatus = "created" | "processing" | "hold" | "success" | "failure" | "reversed" | "expired";
export const MONO_STATUSES: MonoInvoiceStatus[] = ["created", "processing", "hold", "success", "failure", "reversed", "expired"];

export class MonoError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function monoFetch<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${MONO_API}${path}`, {
      method: init.method ?? "GET",
      headers: { "X-Token": token, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new MonoError("monobank не відповідає — спробуйте ще раз за хвилину", 0);
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    // 401/403 = the token is wrong or revoked; anything else is passed through
    // with monobank's own text, which is already human-readable.
    if (res.status === 401 || res.status === 403) throw new MonoError("monobank не прийняв токен — перевірте, що скопіювали його повністю", res.status);
    const reason = typeof data.errText === "string" ? data.errText : typeof data.errorDescription === "string" ? data.errorDescription : `HTTP ${res.status}`;
    throw new MonoError(`monobank: ${reason}`, res.status);
  }
  return data as T;
}

export interface MonoMerchant {
  merchantId: string;
  merchantName: string;
  edrpou: string;
}

export const getMerchantDetails = (token: string) => monoFetch<MonoMerchant>(token, "/api/merchant/details");

export async function getWebhookPubkey(token: string): Promise<string> {
  const data = await monoFetch<{ key: string }>(token, "/api/merchant/pubkey");
  if (!data.key) throw new MonoError("monobank не повернув ключ підпису", 502);
  return data.key;
}

export interface CreateInvoiceInput {
  amount: number; // minor units
  ccy?: number;
  reference: string;
  destination: string;
  webHookUrl: string;
  redirectUrl?: string;
  validitySeconds?: number;
  // Card tokenization for a recurring offer's first charge. IMPORTANT: per
  // the live docs (api.monobank.ua/docs/acquiring.html, "Створення рахунку"),
  // tokenization is OFF by default for every merchant — "Для підключення
  // функції, зверніться, будь ласка, в службу турботи monobank." Setting
  // this without that support-desk step silently does nothing useful: the
  // invoice is created but no card ever gets tokenized, so the subscription
  // stays 'awaiting_card' forever. There is no API to check whether it's
  // enabled — the org has to know they asked for it.
  saveCardData?: { saveCard: true; walletId: string };
}

export function createInvoice(token: string, input: CreateInvoiceInput) {
  return monoFetch<{ invoiceId: string; pageUrl: string }>(token, "/api/merchant/invoice/create", {
    method: "POST",
    body: {
      amount: input.amount,
      ccy: input.ccy ?? 980,
      merchantPaymInfo: { reference: input.reference, destination: input.destination },
      webHookUrl: input.webHookUrl,
      ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
      ...(input.validitySeconds ? { validity: input.validitySeconds } : {}),
      ...(input.saveCardData ? { saveCardData: input.saveCardData } : {}),
    },
  });
}

export interface MonoInvoiceState {
  invoiceId: string;
  status: MonoInvoiceStatus;
  amount: number;
  ccy: number;
  finalAmount?: number;
  failureReason?: string;
  errCode?: string;
  reference?: string;
  createdDate?: string;
  modifiedDate?: string;
  // Present when saveCardData was set on invoice creation and Monobank
  // actually tokenized the card — see the warning on CreateInvoiceInput.
  walletData?: { cardToken: string; walletId: string; status: string };
}

export const getInvoiceStatus = (token: string, invoiceId: string) =>
  monoFetch<MonoInvoiceState>(token, `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`);

export interface WalletChargeInput {
  cardToken: string;
  amount: number; // minor units
  ccy?: number;
  reference: string;
  destination: string;
  webHookUrl?: string;
  // 'merchant' = we're charging on a schedule, the customer isn't present
  // (a subscription renewal). 'client' = the customer is actively paying
  // right now from a saved card. charge-subscriptions-background.ts always
  // uses 'merchant'.
  initiationKind: "merchant" | "client";
}

export interface WalletChargeResult {
  invoiceId: string;
  tdsUrl?: string;
  status: MonoInvoiceStatus | "processing";
  failureReason?: string;
  amount: number;
  ccy: number;
  createdDate?: string;
  modifiedDate?: string;
}

/** Charges a previously tokenized card — POST /api/merchant/wallet/payment. */
export function chargeByToken(token: string, input: WalletChargeInput) {
  return monoFetch<WalletChargeResult>(token, "/api/merchant/wallet/payment", {
    method: "POST",
    body: {
      cardToken: input.cardToken,
      amount: input.amount,
      ccy: input.ccy ?? 980,
      initiationKind: input.initiationKind,
      merchantPaymInfo: { reference: input.reference, destination: input.destination },
      ...(input.webHookUrl ? { webHookUrl: input.webHookUrl } : {}),
    },
  });
}

/** Removes a tokenized card from Monobank's side — used on cancellation. */
export function deleteWalletCard(token: string, cardToken: string) {
  return monoFetch<Record<string, never>>(token, `/api/merchant/wallet/card?cardToken=${encodeURIComponent(cardToken)}`, { method: "DELETE" });
}

/**
 * X-Sign = base64 ECDSA (SHA-256, DER) signature over the exact raw request
 * body; the key is base64 of a PEM-encoded X.509 public key.
 */
export function verifyMonoSignature(pubkeyBase64: string, rawBody: string | Buffer, xSignBase64: string): boolean {
  try {
    const pem = Buffer.from(pubkeyBase64, "base64").toString("utf8");
    const verifier = createVerify("SHA256");
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(pem, Buffer.from(xSignBase64, "base64"));
  } catch {
    return false;
  }
}

/** The org's decrypted token, or null when not connected. Service role only. */
export async function readOrgMonoToken(supabase: SupabaseClient, orgId: string) {
  const { data: account } = await supabase
    .from("org_payment_accounts")
    .select("id, token_secret_id, test_mode, webhook_pubkey")
    .eq("org_id", orgId)
    .eq("provider", "monobank")
    .maybeSingle();
  if (!account) return null;
  const { data: token } = await supabase.rpc("vault_read_secret", { secret_id: account.token_secret_id });
  if (!token) return null;
  return { account, token: String(token) };
}

// Minor units → "1 250,00" for messages shown to people.
export function formatUah(minor: number): string {
  return (minor / 100).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
