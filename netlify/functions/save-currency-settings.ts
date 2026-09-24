import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_RATES = 30;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Sets the org's base currency and replaces its manual exchange-rate table in
// one call. organizations / org_currency_rates are SELECT-only under RLS, so
// the write comes through here with the service role, scoped to the caller's
// org resolved from their session (see CLAUDE.md: org_id scoping).
//
// Rates are "1 unit of <currency> = rate_to_base units of the base currency".
// Changing the base currency does NOT convert existing rates — the caller
// re-enters them against the new base.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let baseCurrency = "";
  const rates = new Map<string, number>();
  try {
    const body = JSON.parse(event.body || "{}");
    baseCurrency = typeof body.baseCurrency === "string" ? body.baseCurrency.trim().toUpperCase() : "";
    if (!CURRENCY_RE.test(baseCurrency)) {
      return jsonResponse(400, { error: "Базова валюта — 3 латинські літери, напр. UAH" });
    }
    if (!Array.isArray(body.rates) || body.rates.length > MAX_RATES) {
      return jsonResponse(400, { error: `rates має бути масивом (макс. ${MAX_RATES})` });
    }
    for (const r of body.rates as { currency?: unknown; rate?: unknown }[]) {
      const currency = typeof r?.currency === "string" ? r.currency.trim().toUpperCase() : "";
      const rate = typeof r?.rate === "number" ? r.rate : Number(r?.rate);
      if (!CURRENCY_RE.test(currency)) return jsonResponse(400, { error: `Невалідний код валюти: «${String(r?.currency ?? "")}»` });
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1e9) {
        return jsonResponse(400, { error: `Курс для ${currency} має бути додатним числом` });
      }
      // The base currency is always 1:1 with itself — a row for it is noise.
      if (currency === baseCurrency) continue;
      if (rates.has(currency)) return jsonResponse(400, { error: `Валюта ${currency} вказана двічі` });
      rates.set(currency, rate);
    }
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  const { error: orgError } = await supabase.from("organizations").update({ base_currency: baseCurrency }).eq("id", orgId);
  if (orgError) {
    console.error("save-currency-settings: base currency update failed", orgError);
    return jsonResponse(500, { error: "Не вдалося зберегти базову валюту" });
  }

  const now = new Date().toISOString();
  if (rates.size > 0) {
    const { error: upsertError } = await supabase.from("org_currency_rates").upsert(
      Array.from(rates, ([currency, rate]) => ({ org_id: orgId, currency, rate_to_base: rate, updated_at: now })),
      { onConflict: "org_id,currency" },
    );
    if (upsertError) {
      console.error("save-currency-settings: rates upsert failed", upsertError);
      return jsonResponse(500, { error: "Не вдалося зберегти курси" });
    }
  }

  // Anything not in the submitted list is a rate the user removed.
  let cleanup = supabase.from("org_currency_rates").delete().eq("org_id", orgId);
  if (rates.size > 0) cleanup = cleanup.not("currency", "in", `(${Array.from(rates.keys()).join(",")})`);
  const { error: deleteError } = await cleanup;
  if (deleteError) {
    console.error("save-currency-settings: stale rates delete failed", deleteError);
    return jsonResponse(500, { error: "Курси збережено, але не вдалося прибрати видалені" });
  }

  return jsonResponse(200, {
    ok: true,
    baseCurrency,
    rates: Array.from(rates, ([currency, rate]) => ({ currency, rate })),
  });
};
