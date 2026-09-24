// Pure period/finance helpers behind the Analytics KPI cards — no React, no
// Supabase, so the maths can be exercised on its own.

export interface StageHistoryRow {
  lead_id: string
  stage_id: string
  value: number | null
  entered_at: string
}

// ---------- Єдиний період сторінки. Усі дати — календарні дні UTC у форматі
// YYYY-MM-DD (як і групування подій нижче), межі включно. ----------

export type PeriodPreset = 7 | 30 | 90 | 'custom'

export interface Period {
  from: string
  to: string
  days: number
  /** The custom range was longer than MAX_PERIOD_DAYS and got cut. */
  clamped: boolean
}

export const MAX_PERIOD_DAYS = 366

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

export function resolvePeriod(preset: PeriodPreset, customFrom: string, customTo: string): Period {
  const today = todayUtc()
  if (preset !== 'custom' || !customFrom || !customTo) {
    const days = preset === 'custom' ? 30 : preset
    return { from: addDays(today, -(days - 1)), to: today, days, clamped: false }
  }
  let from = customFrom <= customTo ? customFrom : customTo
  const to = customFrom <= customTo ? customTo : customFrom
  let days = daysBetween(from, to)
  let clamped = false
  if (days > MAX_PERIOD_DAYS) {
    from = addDays(to, -(MAX_PERIOD_DAYS - 1))
    days = MAX_PERIOD_DAYS
    clamped = true
  }
  return { from, to, days, clamped }
}

/** The window of equal length directly before `period`, for "vs previous" deltas. */
export function previousPeriod(period: Period): { from: string; to: string } {
  const to = addDays(period.from, -1)
  return { from: addDays(to, -(period.days - 1)), to }
}

export function inRange(iso: string, from: string, to: string): boolean {
  const day = iso.slice(0, 10)
  return day >= from && day <= to
}

export function listDays(from: string, to: string): string[] {
  const days: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
  return days
}

// ---------- Фінансові КРІ: продажі, витрати, ROI ----------

/** Only the columns the summary needs — the whole org's rows, not one import's. */
export interface AdSpendSummaryRow {
  id: string
  spend: number
  currency: string | null
  report_start_date: string | null
  report_end_date: string | null
}

// A report row counts toward a period when its reporting window touches it at
// all (the same overlap rule the table always used) — the row is taken whole,
// never prorated by days. Rows with no reporting dates can't be placed on the
// timeline, so they never count.
export function rowOverlaps(row: { report_start_date: string | null; report_end_date: string | null }, from: string, to: string): boolean {
  const start = row.report_start_date ?? row.report_end_date
  const end = row.report_end_date ?? row.report_start_date
  if (!start || !end) return false
  return end >= from && start <= to
}

export type SpendExclusion = 'no_rate' | 'no_currency'

// Converts one row into the base currency. null spend = the row has to be left
// out of the sum: no currency in the file (not guessed), or no rate for it.
export function convertSpend(
  row: { spend: number; currency: string | null },
  base: string,
  rates: Map<string, number>,
): { value: number } | { excluded: SpendExclusion } {
  const currency = row.currency?.toUpperCase() ?? null
  if (!currency) return { excluded: 'no_currency' }
  if (currency === base) return { value: Number(row.spend) }
  const rate = rates.get(currency)
  if (!rate) return { excluded: 'no_rate' }
  return { value: Number(row.spend) * rate }
}

export interface SpendSummary {
  total: number
  counted: number
  /** Currencies that had rows in the period but no saved rate. */
  missingRates: string[]
  noCurrency: number
}

export function summarizeSpend(
  rows: AdSpendSummaryRow[],
  from: string,
  to: string,
  base: string,
  rates: Map<string, number>,
): SpendSummary {
  let total = 0
  let counted = 0
  let noCurrency = 0
  const missing = new Set<string>()
  for (const row of rows) {
    if (!rowOverlaps(row, from, to)) continue
    const converted = convertSpend(row, base, rates)
    if ('value' in converted) {
      total += converted.value
      counted += 1
    } else if (converted.excluded === 'no_currency') {
      noCurrency += 1
    } else if (row.currency) {
      missing.add(row.currency.toUpperCase())
    }
  }
  return { total, counted, missingRates: Array.from(missing).sort(), noCurrency }
}

export interface SalesSummary {
  total: number
  leads: number
  /** Sum per UTC day the sale was recorded, for the sparkline. */
  byDay: Map<string, number>
}

// Same "latest value per lead" rule as the funnel above (a lead that re-entered
// «Продажа» must not be counted twice), applied to the entries inside the
// period: each lead contributes the value of its last entry within it.
export function summarizeSales(history: StageHistoryRow[], stageId: string | null, from: string, to: string): SalesSummary {
  const latest = new Map<string, StageHistoryRow>()
  if (stageId) {
    for (const row of history) {
      if (row.stage_id !== stageId || !inRange(row.entered_at, from, to)) continue
      const seen = latest.get(row.lead_id)
      if (!seen || seen.entered_at <= row.entered_at) latest.set(row.lead_id, row)
    }
  }
  let total = 0
  const byDay = new Map<string, number>()
  for (const row of latest.values()) {
    const value = Number(row.value ?? 0)
    total += value
    const day = row.entered_at.slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + value)
  }
  return { total, leads: latest.size, byDay }
}

export function roiPercent(sales: number, spend: number): number | null {
  return spend > 0 ? ((sales - spend) / spend) * 100 : null
}

export function pctChange(current: number, previous: number): number | null {
  return previous > 0 ? ((current - previous) / previous) * 100 : null
}

