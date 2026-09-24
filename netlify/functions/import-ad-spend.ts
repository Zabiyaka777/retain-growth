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

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Minimal RFC4180 line splitter — handles quoted fields (including embedded
// commas and escaped "" quotes), which a plain text.split(',') would break
// on for any campaign name containing a comma. Not a streaming parser: fine
// for a single ad-account CSV export, not meant for huge files.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strips a leading UTF-8 BOM, which Excel/Meta exports commonly include
  // and which would otherwise end up glued to the first header name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // swallow — \n (bare or in \r\n) is what actually ends the row
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Last field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

// Exact match first, then substring — "amount spent (usd)" should still hit
// the "amount spent" pattern, and a currency-suffixed header is exactly what
// Meta Ads Manager exports.
//
// `used` holds the indices already claimed by earlier lookups, so no two
// fields can resolve to the same column. That matters because the Russian
// export has genuinely overlapping headers: "Цена за результаты" contains
// "результат", so a bare substring pass for the Результат column would
// happily steal the cost-per-result one. Claim order below is therefore
// most-specific-first.
function findColumn(headers: string[], patterns: string[], used: Set<number>): number {
  const normalized = headers.map(normalizeHeader);
  for (const p of patterns) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && h === p);
    if (idx !== -1) {
      used.add(idx);
      return idx;
    }
  }
  for (const p of patterns) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && h.includes(p));
    if (idx !== -1) {
      used.add(idx);
      return idx;
    }
  }
  return -1;
}

interface SpendColumn {
  index: number;
  currency: string | null;
}

// The currency-suffixed header ("Потраченная сумма (UAH)") is checked first,
// since it also yields the currency — falling through to the plain
// SPEND_PATTERNS list only for the rarer export that has no currency suffix
// at all, where currency is left null rather than guessed.
function findSpendColumn(headers: string[], used: Set<number>): SpendColumn {
  const normalized = headers.map(normalizeHeader);

  for (let i = 0; i < normalized.length; i++) {
    if (used.has(i)) continue;
    const match = normalized[i].match(SPEND_CURRENCY_REGEX);
    if (match) {
      used.add(i);
      return { index: i, currency: match[2].toUpperCase() };
    }
  }

  return { index: findColumn(headers, SPEND_PATTERNS, used), currency: null };
}

// Despite the name, this resolves to whichever level Meta's export actually
// breaks down by — campaign, ad set/group, or individual ad. Only one of
// these ever appears in a given export (it's a single breakdown level), so
// the row identifier just ends up being "campaign name" for a campaign-level
// export and "ad name" for an ad-level one — matchLink() below fuzzy-matches
// it against lead_gen_links.name regardless of which level it is.
const CAMPAIGN_NAME_PATTERNS = [
  "название кампании",
  "назва кампанії",
  "campaign name",
  "назва кампании",
  "название группы объявлений",
  "назва групи оголошень",
  "ad set name",
  "adset name",
  "название объявления",
  "назва оголошення",
  "ad name",
  "campaign",
];
// Currency-less fallback only — see findSpendColumn below for the (usual)
// currency-suffixed case, which accepts any currency rather than assuming USD.
const SPEND_PATTERNS = ["потраченная сумма", "потрачена сума", "витрачена сума", "amount spent", "витрачено", "витрати", "spend", "cost"];
// "Потраченная сумма (UAH)", "Amount spent (USD)", "Потрачена сума (EUR)" —
// the ad account's own billing currency, which varies per account/export.
// Matches any currency code in the parens and captures it, instead of only
// ever recognizing the USD-suffixed header.
const SPEND_CURRENCY_REGEX = /^(потраченная сумма|потрачена сума|витрачена сума|amount spent)\s*\(([^)]+)\)$/;
const REPORT_START_PATTERNS = ["дата начала отчетности", "дата початку звітності", "початок звітності", "reporting starts", "reporting start"];
const REPORT_END_PATTERNS = ["окончание отчетности", "закінчення звітності", "кінець звітності", "reporting ends", "reporting end"];
// Deliberately the full two-word phrase, never a bare "показ": "Показы"
// (impressions) starts with the same stem and would be swallowed by it.
const STATUS_PATTERNS = ["показ кампании", "показ кампанії", "campaign delivery", "delivery"];
const COST_PER_RESULT_PATTERNS = ["цена за результаты", "цена за результат", "ціна за результат", "cost per result", "cost per results"];
const RESULTS_PATTERNS = ["результат", "результаты", "результати", "results"];
const CTR_PATTERNS = ["ctr (all)", "ctr (все)", "ctr (усі)", "ctr"];
const IMPRESSIONS_PATTERNS = ["показы", "покази", "impressions"];
const CLICKS_PATTERNS = ["клики", "кліки", "link clicks", "clicks"];

// Meta exports use plain "1234.56"; some locales export "1 234,56" or
// "1234,56". Comma-with-no-dot is treated as a decimal separator, otherwise
// commas are stripped as thousands separators — a heuristic, not a full
// locale parser, which is more than a "найпростіший формат" CSV needs.
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d,.\-]/g, "").trim();
  if (!cleaned) return null;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  const normalized = hasComma && !hasDot ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

// Meta exports the reporting window as ISO (2026-09-01). Locale-formatted
// exports (01.09.2026 / 01/09/2026) are accepted too — day-first, which is
// what the ru/uk exports produce. Anything else yields null rather than a
// guessed date.
function parseDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dayFirst = value.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dayFirst) {
    const [, d, m, y] = dayFirst;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return null;
}

function normalizeForMatch(s: string): string {
  return s.trim().toLowerCase();
}

// Exact match wins outright. Otherwise, among links where one name contains
// the other, the longest link name is preferred — the more specific match is
// less likely to be a coincidental short-substring hit.
function matchLink(campaignName: string, links: { id: string; name: string }[]): string | null {
  const target = normalizeForMatch(campaignName);
  if (!target) return null;

  const exact = links.find((l) => normalizeForMatch(l.name) === target);
  if (exact) return exact.id;

  let best: { id: string; name: string } | null = null;
  for (const link of links) {
    const name = normalizeForMatch(link.name);
    if (!name) continue;
    if (target.includes(name) || name.includes(target)) {
      if (!best || name.length > normalizeForMatch(best.name).length) best = link;
    }
  }
  return best?.id ?? null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let filename: string | undefined;
  let csvText: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    filename = typeof body.filename === "string" ? body.filename : undefined;
    csvText = typeof body.csvText === "string" ? body.csvText : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!filename || !csvText) {
    return jsonResponse(400, { error: "filename і csvText обов'язкові" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", userData.user.id)
    .single();
  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }
  const orgId = profile.org_id as string;

  const table = parseCsv(csvText);
  if (table.length < 2) {
    return jsonResponse(400, { error: "Файл порожній або не містить рядків з даними" });
  }

  const [headerRow, ...dataRows] = table;

  // Claim order is deliberate — see findColumn: each lookup consumes its
  // column, and the ambiguous pairs (цена за результаты/результат,
  // показ кампании/показы) are resolved by taking the narrower one first.
  const used = new Set<number>();
  const campaignIdx = findColumn(headerRow, CAMPAIGN_NAME_PATTERNS, used);
  const { index: spendIdx, currency: spendCurrency } = findSpendColumn(headerRow, used);
  if (campaignIdx === -1 || spendIdx === -1) {
    return jsonResponse(400, {
      error: "Не вдалося розпізнати колонки «Назва кампанії/групи оголошень/оголошення» та «Потрачена сума» у файлі",
    });
  }
  const reportStartIdx = findColumn(headerRow, REPORT_START_PATTERNS, used);
  const reportEndIdx = findColumn(headerRow, REPORT_END_PATTERNS, used);
  const statusIdx = findColumn(headerRow, STATUS_PATTERNS, used);
  const costPerResultIdx = findColumn(headerRow, COST_PER_RESULT_PATTERNS, used);
  const resultsIdx = findColumn(headerRow, RESULTS_PATTERNS, used);
  const ctrIdx = findColumn(headerRow, CTR_PATTERNS, used);
  const impressionsIdx = findColumn(headerRow, IMPRESSIONS_PATTERNS, used);
  const clicksIdx = findColumn(headerRow, CLICKS_PATTERNS, used);

  const { data: links, error: linksError } = await supabase.from("lead_gen_links").select("id, name").eq("org_id", orgId);
  if (linksError) {
    console.error("import-ad-spend: lead_gen_links lookup failed", linksError);
    return jsonResponse(500, { error: "Не вдалося завантажити список посилань для зіставлення" });
  }
  const linkList = (links ?? []) as { id: string; name: string }[];

  const parsedRows = dataRows
    .map((cells) => {
      const campaignName = (cells[campaignIdx] ?? "").trim();
      const spend = parseNumber(cells[spendIdx] ?? "");
      if (!campaignName || spend === null) return null;

      const impressions = impressionsIdx !== -1 ? parseNumber(cells[impressionsIdx] ?? "") : null;
      const clicks = clicksIdx !== -1 ? parseNumber(cells[clicksIdx] ?? "") : null;

      // CTR is taken verbatim when the file has the column. Only when it
      // doesn't is it derived from clicks/impressions — and if either of
      // those is missing (or impressions is 0), it stays null rather than
      // becoming an invented number.
      let ctrPercent = ctrIdx !== -1 ? parseNumber(cells[ctrIdx] ?? "") : null;
      if (ctrPercent === null && clicks !== null && impressions !== null && impressions > 0) {
        ctrPercent = (clicks / impressions) * 100;
      }

      const statusLabel = statusIdx !== -1 ? (cells[statusIdx] ?? "").trim() : "";

      return {
        campaign_name: campaignName,
        spend,
        currency: spendCurrency,
        impressions: impressions !== null ? Math.round(impressions) : null,
        clicks: clicks !== null ? Math.round(clicks) : null,
        report_start_date: reportStartIdx !== -1 ? parseDate(cells[reportStartIdx] ?? "") : null,
        report_end_date: reportEndIdx !== -1 ? parseDate(cells[reportEndIdx] ?? "") : null,
        status_label: statusLabel || null,
        results: resultsIdx !== -1 ? parseNumber(cells[resultsIdx] ?? "") : null,
        ctr_percent: ctrPercent,
        cost_per_result: costPerResultIdx !== -1 ? parseNumber(cells[costPerResultIdx] ?? "") : null,
        matched_link_id: matchLink(campaignName, linkList),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (parsedRows.length === 0) {
    return jsonResponse(400, { error: "У файлі не знайдено жодного валідного рядка з кампанією та витратами" });
  }

  const { data: importRow, error: importError } = await supabase
    .from("ad_spend_imports")
    .insert({ org_id: orgId, filename })
    .select("id, filename, imported_at")
    .single();
  if (importError || !importRow) {
    console.error("import-ad-spend: ad_spend_imports insert failed", importError);
    return jsonResponse(500, { error: "Не вдалося створити запис імпорту" });
  }

  const { data: insertedRows, error: rowsError } = await supabase
    .from("ad_spend_rows")
    .insert(parsedRows.map((r) => ({ ...r, import_id: importRow.id, org_id: orgId })))
    .select(
      "id, campaign_name, spend, currency, impressions, clicks, matched_link_id, report_start_date, report_end_date, status_label, results, ctr_percent, cost_per_result",
    );

  if (rowsError) {
    console.error("import-ad-spend: ad_spend_rows insert failed", rowsError);
    return jsonResponse(500, { error: "Не вдалося зберегти рядки імпорту" });
  }

  return jsonResponse(200, { ok: true, import: importRow, rows: insertedRows ?? [] });
};
