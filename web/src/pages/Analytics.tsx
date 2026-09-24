import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  MAX_PERIOD_DAYS,
  convertSpend,
  costPerSubscriber,
  countSubscribes,
  inRange,
  listDays,
  pctChange,
  previousPeriod,
  resolvePeriod,
  roiPercent,
  rowOverlaps,
  summarizeSales,
  subscribesByChannel,
  summarizeSpend,
  todayUtc,
  type AdSpendSummaryRow,
  type PeriodPreset,
  type StageHistoryRow,
} from '../lib/analyticsFinance'
import {
  IconAlert,
  IconChevronDown,
  IconChevronUp,
  IconHistory,
  IconPercent,
  IconChat,
  IconSparkles,
  IconSpinner,
  IconTarget,
  IconTrendingUp,
  IconUpload,
  IconUsers,
  IconWallet,
} from '../components/icons'

interface LeadGenLinkRow {
  id: string
  name: string
}

type SubscriptionEventType = 'subscribe' | 'unsubscribe'

interface SubscriptionEventRow {
  link_id: string | null
  event_type: SubscriptionEventType
  created_at: string
  /** telegram | whatsapp | fbm; null only on events written before the column existed and never backfilled. */
  channel_type: string | null
}

interface LeadSourceRow {
  source_link_id: string | null
}

interface LinkStats {
  linkId: string
  name: string
  subscribes: number
  unsubscribes: number
  net: number
  totalLeads: number
}

interface DayBucket {
  date: string
  subscribes: number
  unsubscribes: number
}

// Whole 1000-row pages until one comes back short — PostgREST caps a single
// response at 1000 rows, which would silently truncate any sum built on top.
// Callers must order by a unique column so pages never overlap or skip.
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) return { data: out, error }
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return { data: out, error: null }
}

const fetchSubscriptionEvents = () =>
  fetchAll<SubscriptionEventRow>((a, b) =>
    supabase.from('lead_subscription_events').select('link_id, event_type, created_at, channel_type').order('id').range(a, b),
  )

const fetchStageHistory = () =>
  fetchAll<StageHistoryRow>((a, b) =>
    supabase.from('lead_stage_history').select('lead_id, stage_id, value, entered_at').order('id').range(a, b),
  )

// Original brand colours, straight from each platform's identity.
const CHANNELS = [
  { key: 'telegram', label: 'Telegram', color: '#26A5E4' },
  { key: 'whatsapp', label: 'WhatsApp', color: '#25D366' },
  { key: 'fbm', label: 'Messenger', color: '#0084FF' },
] as const

/** Tweens a number toward its latest value (count-up on load, glide on change). */
function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const firstRun = useRef(true)
  const [pulse, setPulse] = useState(0)

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      shownRef.current = value
      setShown(value)
      return
    }
    if (!firstRun.current) setPulse((n) => n + 1)
    firstRun.current = false

    const from = shownRef.current
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 650)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = from + (value - from) * eased
      shownRef.current = next
      setShown(next)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return (
    <span key={pulse} className={`anim-num${pulse > 0 ? ' is-pulse' : ''}`}>
      {format(shown)}
    </span>
  )
}

function buildLinkStats(
  links: LeadGenLinkRow[],
  events: SubscriptionEventRow[],
  leads: LeadSourceRow[],
  from: string,
  to: string,
): LinkStats[] {
  const eventTotals = new Map<string, { subscribes: number; unsubscribes: number }>()
  for (const ev of events) {
    if (!ev.link_id || !inRange(ev.created_at, from, to)) continue
    const totals = eventTotals.get(ev.link_id) ?? { subscribes: 0, unsubscribes: 0 }
    if (ev.event_type === 'subscribe') totals.subscribes += 1
    else totals.unsubscribes += 1
    eventTotals.set(ev.link_id, totals)
  }

  const leadCounts = new Map<string, number>()
  for (const lead of leads) {
    if (!lead.source_link_id) continue
    leadCounts.set(lead.source_link_id, (leadCounts.get(lead.source_link_id) ?? 0) + 1)
  }

  return links.map((link) => {
    const totals = eventTotals.get(link.id) ?? { subscribes: 0, unsubscribes: 0 }
    return {
      linkId: link.id,
      name: link.name,
      subscribes: totals.subscribes,
      unsubscribes: totals.unsubscribes,
      net: totals.subscribes - totals.unsubscribes,
      totalLeads: leadCounts.get(link.id) ?? 0,
    }
  })
}

// Buckets by the event's UTC calendar date (created_at.slice(0, 10)) — a
// simple day grouping, not a timezone-aware local-day one. Fine for a
// "простий" trend view; a precise per-org-timezone cutoff would need more
// than this page asks for. linkId null = every event (the org-wide card).
function buildDailyBuckets(events: SubscriptionEventRow[], linkId: string | null, from: string, to: string): DayBucket[] {
  const days: DayBucket[] = listDays(from, to).map((date) => ({ date, subscribes: 0, unsubscribes: 0 }))

  const byDate = new Map(days.map((d) => [d.date, d]))
  for (const ev of events) {
    if (linkId !== null && ev.link_id !== linkId) continue
    const bucket = byDate.get(ev.created_at.slice(0, 10))
    if (!bucket) continue // outside the selected period
    if (ev.event_type === 'subscribe') bucket.subscribes += 1
    else bucket.unsubscribes += 1
  }

  return days
}

function formatShortDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })
}

const CHART_HEIGHT = 64
const DAY_SLOT = 10
const BAR_GAP = 1

function DailyChart({ days }: { days: DayBucket[] }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.subscribes, d.unsubscribes)))
  const width = days.length * DAY_SLOT
  const barWidth = (DAY_SLOT - BAR_GAP) / 2 - BAR_GAP

  return (
    <div className="analytics-chart-wrap">
      <div className="analytics-chart-legend">
        <span>
          <i className="analytics-legend-dot analytics-legend-sub" /> Підписки
        </span>
        <span>
          <i className="analytics-legend-dot analytics-legend-unsub" /> Відписки
        </span>
      </div>
      <svg className="analytics-chart" viewBox={`0 0 ${width} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="Підписки та відписки за обраний період">
        {days.map((day, i) => {
          const x = i * DAY_SLOT
          const subHeight = (day.subscribes / max) * (CHART_HEIGHT - 4)
          const unsubHeight = (day.unsubscribes / max) * (CHART_HEIGHT - 4)
          return (
            <g key={day.date}>
              <title>
                {formatShortDate(day.date)}: +{day.subscribes} / −{day.unsubscribes}
              </title>
              <rect
                className="analytics-bar-sub"
                x={x}
                y={CHART_HEIGHT - subHeight}
                width={Math.max(barWidth, 0.5)}
                height={Math.max(subHeight, day.subscribes > 0 ? 1 : 0)}
              />
              <rect
                className="analytics-bar-unsub"
                x={x + barWidth + BAR_GAP}
                y={CHART_HEIGHT - unsubHeight}
                width={Math.max(barWidth, 0.5)}
                height={Math.max(unsubHeight, day.unsubscribes > 0 ? 1 : 0)}
              />
            </g>
          )
        })}
      </svg>
      <div className="analytics-chart-axis">
        <span>{formatShortDate(days[0].date)}</span>
        <span>{formatShortDate(days[days.length - 1].date)}</span>
      </div>
    </div>
  )
}

// ---------- Ad spend (separate section, independent from Підписки за
// джерелом above — reads `links`/`leadSources` state the other section
// already loads, but owns its own fetch/state/handlers entirely). ----------

interface AdSpendImportRow {
  id: string
  filename: string
  imported_at: string
}

interface AdSpendRow {
  id: string
  campaign_name: string
  spend: number
  // Whatever currency the ad account's own export was billed in — varies per
  // account (UAH/USD/EUR/...), so it's read from the file, not assumed.
  currency: string | null
  impressions: number | null
  clicks: number | null
  matched_link_id: string | null
  report_start_date: string | null
  report_end_date: string | null
  status_label: string | null
  results: number | null
  ctr_percent: number | null
  cost_per_result: number | null
}

const AD_SPEND_ROW_COLUMNS =
  'id, campaign_name, spend, currency, impressions, clicks, matched_link_id, report_start_date, report_end_date, status_label, results, ctr_percent, cost_per_result'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatPeriodDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function formatPeriod(start: string | null, end: string | null): string {
  if (start && end) return `${formatPeriodDate(start)} – ${formatPeriodDate(end)}`
  if (start) return `з ${formatPeriodDate(start)}`
  if (end) return `до ${formatPeriodDate(end)}`
  return '—'
}

// Results come out of the file as whole counts far more often than not, so
// they're shown as-is rather than padded to a fixed 2 decimals like money.
function formatCount(value: number | null): string | null {
  if (value === null) return null
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

// ---------- Аналітична воронка (org-wide sales funnel — own fetch, own
// state, own render; shares nothing with the two sections above). ----------

interface StageRow {
  id: string
  name: string
  position: number
  /** null = built-in stage, shared by every org. */
  org_id: string | null
}

interface FunnelRef {
  id: string
  name: string
}

/** Which funnel a lead-gen link drops its leads into. */
interface LinkFunnelRow {
  id: string
  funnel_id: string | null
}

/** Every lead with the link it arrived through (null = direct, no LGT). */
interface LeadLinkRow {
  id: string
  source_link_id: string | null
}

/** Conversion nodes, i.e. which stages a given funnel can actually mark. */
interface ConversionNodeRow {
  funnel_id: string
  config: { stage_id?: string } | null
}

interface StageFunnelStep {
  id: string
  name: string
  leads: number
  total: number
  /** Share of the previous step's lead count; null on the first step. */
  prevPercent: number | null
  /** Card width, tapering with the share of the first step's lead count. */
  widthPercent: number
}

// The narrowest a card may get, so the last steps of a steep funnel stay
// readable instead of collapsing into a sliver.
const MIN_CARD_WIDTH = 34

// A lead counts once per stage no matter how many times it entered it, so the
// money figure takes the latest value recorded for that (lead, stage) pair
// rather than summing every visit — otherwise a lead who re-entered a stage
// would inflate the sum while leaving the count unchanged.
function buildStageFunnel(stages: StageRow[], history: StageHistoryRow[]): StageFunnelStep[] {
  const latestByStage = new Map<string, Map<string, StageHistoryRow>>()
  for (const row of history) {
    let perLead = latestByStage.get(row.stage_id)
    if (!perLead) {
      perLead = new Map()
      latestByStage.set(row.stage_id, perLead)
    }
    const seen = perLead.get(row.lead_id)
    if (!seen || seen.entered_at <= row.entered_at) perLead.set(row.lead_id, row)
  }

  const counts = stages.map((stage) => latestByStage.get(stage.id)?.size ?? 0)
  const first = counts[0] ?? 0

  return stages.map((stage, i) => {
    let total = 0
    const perLead = latestByStage.get(stage.id)
    if (perLead) for (const row of perLead.values()) total += Number(row.value ?? 0)

    const prev = i === 0 ? null : counts[i - 1]

    return {
      id: stage.id,
      name: stage.name,
      leads: counts[i],
      total,
      prevPercent: prev === null || prev === 0 ? null : (counts[i] / prev) * 100,
      widthPercent: first === 0 ? 100 : MIN_CARD_WIDTH + (counts[i] / first) * (100 - MIN_CARD_WIDTH),
    }
  })
}

// Leads reachable from one funnel: the ones whose source link points at it.
// A lead with no source_link_id came in directly and can't be attributed to
// any funnel, so it only ever shows under "Усі тунелі".
function leadIdsForFunnel(funnelId: string, links: LinkFunnelRow[], leads: LeadLinkRow[]): Set<string> {
  const linkIds = new Set(links.filter((l) => l.funnel_id === funnelId).map((l) => l.id))
  return new Set(leads.filter((l) => l.source_link_id && linkIds.has(l.source_link_id)).map((l) => l.id))
}

// Built-in stages («Підписка»/«Продажа») are the funnel's fixed bookends and
// always show. A custom stage belongs to the picked funnel only if some
// conversion node in it actually marks that stage — otherwise another funnel's
// stage would sit in the list at a permanent 0.
function stagesForFunnel(funnelId: string, stages: StageRow[], nodes: ConversionNodeRow[]): StageRow[] {
  const owned = new Set(
    nodes.filter((n) => n.funnel_id === funnelId).map((n) => n.config?.stage_id).filter((id): id is string => !!id),
  )
  return stages.filter((stage) => stage.org_id === null || owned.has(stage.id))
}

function formatMoney(value: number): string {
  return value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function countRowsByImport(rows: { import_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.import_id, (counts.get(row.import_id) ?? 0) + 1)
  return counts
}

function formatSigned(value: number, digits = 0): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`
}

function Sparkline({ values }: { values: number[] }) {
  const W = 100
  const H = 28
  const max = Math.max(...values, 0)
  if (values.length < 2 || max <= 0) return <div className="kpi-spark kpi-spark-empty" aria-hidden="true" />
  const step = W / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${(H - 2 - (v / max) * (H - 4)).toFixed(2)}`)
  return (
    <svg className="kpi-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="kpi-spark-fill" points={`0,${H} ${pts.join(' ')} ${W},${H}`} />
      <polyline className="kpi-spark-line" points={pts.join(' ')} />
    </svg>
  )
}

interface KpiCardProps {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  /** Position in the entrance stagger. */
  index?: number
  /** Change vs the previous period of the same length; null = nothing to compare. */
  delta: { text: string; tone: 'up' | 'down' | 'flat' } | null
  hint?: React.ReactNode
  spark?: number[]
}

function KpiCard({ icon, label, value, index = 0, delta, hint, spark }: KpiCardProps) {
  return (
    <div className="card kpi-card" style={{ '--i': index } as React.CSSProperties}>
      <div className="kpi-card-top">
        <span className="kpi-label">{label}</span>
        <span className="kpi-icon" aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-delta-row">
        {delta ? (
          <>
            <span className={`kpi-delta is-${delta.tone}`}>{delta.text}</span>
            <span className="kpi-delta-note">до попереднього періоду</span>
          </>
        ) : (
          <span className="kpi-delta-note">немає бази для порівняння</span>
        )}
      </div>
      {spark && <Sparkline values={spark} />}
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  )
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export default function Analytics() {
  // One period drives every block on the page.
  const [preset, setPreset] = useState<PeriodPreset>(30)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const period = useMemo(() => resolvePeriod(preset, customFrom, customTo), [preset, customFrom, customTo])

  const [links, setLinks] = useState<LeadGenLinkRow[]>([])
  const [events, setEvents] = useState<SubscriptionEventRow[]>([])
  const [leadSources, setLeadSources] = useState<LeadSourceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [linksRes, eventsRes, leadsRes] = await Promise.all([
        supabase.from('lead_gen_links').select('id, name').order('name'),
        fetchSubscriptionEvents(),
        fetchAll<LeadSourceRow>((a, b) =>
          supabase.from('leads').select('source_link_id').not('source_link_id', 'is', null).order('id').range(a, b),
        ),
      ])

      if (cancelled) return

      const firstError = linksRes.error ?? eventsRes.error ?? leadsRes.error
      if (firstError) {
        setError(firstError.message)
      } else {
        setLinks((linksRes.data ?? []) as LeadGenLinkRow[])
        setEvents((eventsRes.data ?? []) as SubscriptionEventRow[])
        setLeadSources((leadsRes.data ?? []) as LeadSourceRow[])
      }
      setLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  const rows = useMemo(
    () => buildLinkStats(links, events, leadSources, period.from, period.to),
    [links, events, leadSources, period.from, period.to],
  )

  // ---- Ad spend section state — independent of everything above ----
  const [adSpendImports, setAdSpendImports] = useState<AdSpendImportRow[]>([])
  const [rowCounts, setRowCounts] = useState<Map<string, number>>(new Map())
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null)
  const [adSpendRows, setAdSpendRows] = useState<AdSpendRow[]>([])
  const [adSpendLoading, setAdSpendLoading] = useState(true)
  const [adSpendError, setAdSpendError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deletingImportId, setDeletingImportId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [matchingRowId, setMatchingRowId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      // One pass over the org's import_ids instead of a count query per
      // import — the list is short and this keeps it to a single round trip.
      const [importsRes, countsRes] = await Promise.all([
        supabase.from('ad_spend_imports').select('id, filename, imported_at').order('imported_at', { ascending: false }),
        supabase.from('ad_spend_rows').select('import_id'),
      ])

      if (cancelled) return
      const firstError = importsRes.error ?? countsRes.error
      if (firstError) {
        setAdSpendError(firstError.message)
        setAdSpendLoading(false)
        return
      }

      const imports = (importsRes.data ?? []) as AdSpendImportRow[]
      setAdSpendImports(imports)
      setRowCounts(countRowsByImport(countsRes.data ?? []))
      setSelectedImportId(imports[0]?.id ?? null)
      setAdSpendLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  // Rows follow the selection, so switching imports (or deleting the shown
  // one) always displays what the list says is selected.
  useEffect(() => {
    if (!selectedImportId) {
      setAdSpendRows([])
      return
    }
    let cancelled = false

    void supabase
      .from('ad_spend_rows')
      .select(AD_SPEND_ROW_COLUMNS)
      .eq('import_id', selectedImportId)
      .order('campaign_name')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setAdSpendError(error.message)
        else setAdSpendRows((data ?? []) as AdSpendRow[])
      })

    return () => {
      cancelled = true
    }
  }, [selectedImportId])

  // Reuses the `leadSources` rows the Підписки-за-джерелом section already
  // fetched (all leads with a source_link_id) — a second full leads fetch
  // here would just duplicate that query for the same data.
  // Overlap semantics: a row shows when its reporting window touches the
  // page period at all, not only when fully contained. Rows imported without
  // any reporting dates can't be placed on the timeline, so they're hidden
  // rather than guessed at.
  const visibleAdSpendRows = useMemo(
    () => adSpendRows.filter((row) => rowOverlaps(row, period.from, period.to)),
    [adSpendRows, period.from, period.to],
  )

  const selectedImport = useMemo(
    () => adSpendImports.find((i) => i.id === selectedImportId) ?? null,
    [adSpendImports, selectedImportId],
  )

  const leadCountsByLink = useMemo(() => {
    const counts = new Map<string, number>()
    for (const lead of leadSources) {
      if (!lead.source_link_id) continue
      counts.set(lead.source_link_id, (counts.get(lead.source_link_id) ?? 0) + 1)
    }
    return counts
  }, [leadSources])

  // ---- Аналітична воронка state — org-wide, not per-funnel: RLS scopes both
  // tables to the caller's org, so no extra filter is needed here ----
  const [stages, setStages] = useState<StageRow[]>([])
  const [stageHistory, setStageHistory] = useState<StageHistoryRow[]>([])
  const [stageLoading, setStageLoading] = useState(true)
  const [stageError, setStageError] = useState<string | null>(null)
  const [funnels, setFunnels] = useState<FunnelRef[]>([])
  const [linkFunnels, setLinkFunnels] = useState<LinkFunnelRow[]>([])
  const [leadLinks, setLeadLinks] = useState<LeadLinkRow[]>([])
  const [conversionNodes, setConversionNodes] = useState<ConversionNodeRow[]>([])
  // '' = «Усі тунелі», the org-wide default.
  const [selectedFunnelId, setSelectedFunnelId] = useState('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [stagesRes, historyRes, funnelsRes, linksRes, leadLinksRes, nodesRes] = await Promise.all([
        supabase.from('funnel_stages').select('id, name, position, org_id').order('position'),
        fetchStageHistory(),
        supabase.from('funnels').select('id, name').order('name'),
        supabase.from('lead_gen_links').select('id, funnel_id'),
        // Own leads fetch: the Підписки-за-джерелом section's one drops leads
        // without a source link and carries no id, and both are needed here.
        supabase.from('leads').select('id, source_link_id'),
        supabase.from('funnel_nodes').select('funnel_id, config').eq('type', 'conversion'),
      ])

      if (cancelled) return

      const firstError =
        stagesRes.error ?? historyRes.error ?? funnelsRes.error ?? linksRes.error ?? leadLinksRes.error ?? nodesRes.error
      if (firstError) {
        setStageError(firstError.message)
      } else {
        setStages((stagesRes.data ?? []) as StageRow[])
        setStageHistory((historyRes.data ?? []) as StageHistoryRow[])
        setFunnels((funnelsRes.data ?? []) as FunnelRef[])
        setLinkFunnels((linksRes.data ?? []) as LinkFunnelRow[])
        setLeadLinks((leadLinksRes.data ?? []) as LeadLinkRow[])
        setConversionNodes((nodesRes.data ?? []) as ConversionNodeRow[])
      }
      setStageLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  // Filtering happens on the inputs only — buildStageFunnel still receives a
  // stage list and a history list and counts them exactly as before.
  const visibleStages = useMemo(
    () => (selectedFunnelId ? stagesForFunnel(selectedFunnelId, stages, conversionNodes) : stages),
    [selectedFunnelId, stages, conversionNodes],
  )

  const visibleStageHistory = useMemo(() => {
    const inPeriod = stageHistory.filter((row) => inRange(row.entered_at, period.from, period.to))
    if (!selectedFunnelId) return inPeriod
    const allowed = leadIdsForFunnel(selectedFunnelId, linkFunnels, leadLinks)
    return inPeriod.filter((row) => allowed.has(row.lead_id))
  }, [selectedFunnelId, stageHistory, linkFunnels, leadLinks, period.from, period.to])

  const funnelSteps = useMemo(
    () => buildStageFunnel(visibleStages, visibleStageHistory),
    [visibleStages, visibleStageHistory],
  )

  // ---- Base currency + manual rates (edited in Налаштування → Організація) ----
  const [baseCurrency, setBaseCurrency] = useState('UAH')
  const [rates, setRates] = useState<Map<string, number>>(new Map())
  const [currencyLoading, setCurrencyLoading] = useState(true)
  const [currencyError, setCurrencyError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      supabase.from('organizations').select('base_currency').maybeSingle(),
      supabase.from('org_currency_rates').select('currency, rate_to_base'),
    ]).then(([orgRes, ratesRes]) => {
      if (cancelled) return
      const firstError = orgRes.error ?? ratesRes.error
      if (firstError) {
        setCurrencyError(firstError.message)
      } else {
        if (orgRes.data?.base_currency) setBaseCurrency((orgRes.data.base_currency as string).toUpperCase())
        setRates(
          new Map(((ratesRes.data ?? []) as { currency: string; rate_to_base: number }[]).map((r) => [r.currency, Number(r.rate_to_base)])),
        )
      }
      setCurrencyLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The KPI sums cover every import, while the table below shows just the
  // selected one — so this is its own fetch of the whole org's rows. Refetched
  // whenever the import list changes (upload / delete).
  const [allAdRows, setAllAdRows] = useState<AdSpendSummaryRow[]>([])
  const [allAdLoading, setAllAdLoading] = useState(true)
  const [allAdError, setAllAdError] = useState<string | null>(null)

  useEffect(() => {
    if (adSpendLoading) return
    let cancelled = false
    void fetchAll<AdSpendSummaryRow>((a, b) =>
      supabase.from('ad_spend_rows').select('id, spend, currency, report_start_date, report_end_date').order('id').range(a, b),
    ).then(({ data, error: fetchError }) => {
      if (cancelled) return
      if (fetchError) setAllAdError(fetchError.message)
      else {
        setAllAdError(null)
        setAllAdRows(data)
      }
      setAllAdLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [adSpendLoading, adSpendImports])

  // «Продажа» is the built-in stage every org shares (org_id null).
  const salesStageId = useMemo(() => stages.find((st) => st.org_id === null && st.name === 'Продажа')?.id ?? null, [stages])
  const prev = useMemo(() => previousPeriod(period), [period])

  const sales = useMemo(() => summarizeSales(stageHistory, salesStageId, period.from, period.to), [stageHistory, salesStageId, period])
  const prevSales = useMemo(() => summarizeSales(stageHistory, salesStageId, prev.from, prev.to), [stageHistory, salesStageId, prev])
  const spend = useMemo(() => summarizeSpend(allAdRows, period.from, period.to, baseCurrency, rates), [allAdRows, period, baseCurrency, rates])
  const prevSpend = useMemo(() => summarizeSpend(allAdRows, prev.from, prev.to, baseCurrency, rates), [allAdRows, prev, baseCurrency, rates])
  const roi = roiPercent(sales.total, spend.total)
  const prevRoi = roiPercent(prevSales.total, prevSpend.total)

  const salesSpark = useMemo(() => listDays(period.from, period.to).map((d) => sales.byDay.get(d) ?? 0), [sales, period])
  const dailyAll = useMemo(() => buildDailyBuckets(events, null, period.from, period.to), [events, period])
  const totalSubscribes = useMemo(() => dailyAll.reduce((n, d) => n + d.subscribes, 0), [dailyAll])
  const totalUnsubscribes = useMemo(() => dailyAll.reduce((n, d) => n + d.unsubscribes, 0), [dailyAll])
  const datelessAdRows = useMemo(() => allAdRows.filter((r) => !r.report_start_date && !r.report_end_date).length, [allAdRows])

  const subscribes = totalSubscribes
  const prevSubscribes = useMemo(() => countSubscribes(events, prev.from, prev.to), [events, prev])
  const cps = costPerSubscriber(spend.total, subscribes)
  const prevCps = costPerSubscriber(prevSpend.total, prevSubscribes)
  const channelSplit = useMemo(
    () => subscribesByChannel(events, period.from, period.to, CHANNELS.map((c) => c.key)),
    [events, period],
  )

  const kpiLoading = loading || stageLoading || allAdLoading || currencyLoading
  const kpiError = error ?? stageError ?? allAdError ?? currencyError

  // Rows the spend sum had to leave out, and why — shown under the card.
  const spendExclusions: string[] = []
  if (spend.missingRates.length > 0) spendExclusions.push(`немає курсу для ${spend.missingRates.join(', ')}`)
  if (spend.noCurrency > 0) spendExclusions.push(`${spend.noCurrency} ${spend.noCurrency === 1 ? 'рядок' : 'рядків'} без валюти`)
  if (datelessAdRows > 0) spendExclusions.push(`${datelessAdRows} ${datelessAdRows === 1 ? 'рядок' : 'рядків'} без дат звіту`)

  // ---- Live refresh: new subscribe events / stage entries land without a reload ----
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const refreshLive = useCallback(async () => {
    const [ev, hist] = await Promise.all([fetchSubscriptionEvents(), fetchStageHistory()])
    if (!ev.error) setEvents(ev.data)
    if (!hist.error) setStageHistory(hist.data)
    if (!ev.error && !hist.error) setLastUpdated(new Date())
  }, [])

  // Debounced: a burst of inserts (an import, a funnel walk) is one refetch.
  // Missed events after a dropped socket or a backgrounded tab are caught the
  // same way — a rejoin and a tab coming back to the foreground both refetch.
  useEffect(() => {
    let timer: number | undefined
    let hasSubscribed = false
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refreshLive(), 1500)
    }
    const channel = supabase
      .channel(`analytics-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lead_subscription_events' }, schedule)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lead_subscription_events' }, schedule)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lead_stage_history' }, schedule)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lead_stage_history' }, schedule)
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) schedule()
        hasSubscribed = true
      })
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      void supabase.removeChannel(channel)
    }
  }, [refreshLive])

  function moneyDelta(current: number, previous: number): KpiCardProps['delta'] {
    const change = pctChange(current, previous)
    if (change === null) return null
    return { text: `${formatSigned(change, 1)}%`, tone: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' }
  }

  function selectCustomPeriod() {
    if (preset !== 'custom' && !customFrom && !customTo) {
      setCustomFrom(period.from)
      setCustomTo(period.to)
    }
    setPreset('custom')
  }

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setAdSpendError(null)
    setUploading(true)

    const csvText = await file.text()
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setAdSpendError('Сесія недійсна, увійдіть знову')
      setUploading(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/import-ad-spend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ filename: file.name, csvText }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAdSpendError(data.error ?? 'Не вдалося імпортувати файл')
      } else {
        const imported = data.import as AdSpendImportRow
        const rows = (data.rows ?? []) as AdSpendRow[]
        setAdSpendImports((prev) => [imported, ...prev.filter((i) => i.id !== imported.id)])
        setRowCounts((prev) => new Map(prev).set(imported.id, rows.length))
        setSelectedImportId(imported.id)
      }
    } catch {
      setAdSpendError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setUploading(false)
    }
  }

  async function handleDeleteImport(importRow: AdSpendImportRow) {
    if (!window.confirm(`Видалити імпорт «${importRow.filename}» разом з усіма його рядками? Дію не можна скасувати.`)) {
      return
    }

    setAdSpendError(null)
    setDeletingImportId(importRow.id)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setAdSpendError('Сесія недійсна, увійдіть знову')
      setDeletingImportId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/delete-ad-spend-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ importId: importRow.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAdSpendError(data.error ?? 'Не вдалося видалити імпорт')
        return
      }

      const remaining = adSpendImports.filter((i) => i.id !== importRow.id)
      setAdSpendImports(remaining)
      setRowCounts((prev) => {
        const next = new Map(prev)
        next.delete(importRow.id)
        return next
      })
      // Deleting the one on screen falls back to the newest of what's left,
      // or to the empty state when nothing is.
      if (selectedImportId === importRow.id) setSelectedImportId(remaining[0]?.id ?? null)
    } catch {
      setAdSpendError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingImportId(null)
    }
  }

  async function handleManualMatch(rowId: string, linkId: string) {
    setAdSpendError(null)
    setMatchingRowId(rowId)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setAdSpendError('Сесія недійсна, увійдіть знову')
      setMatchingRowId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-ad-spend-match', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ rowId, linkId: linkId || null }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAdSpendError(data.error ?? 'Не вдалося зберегти зіставлення')
      } else {
        setAdSpendRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, matched_link_id: linkId || null } : r)))
      }
    } catch {
      setAdSpendError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setMatchingRowId(null)
    }
  }

  return (
    <div className="page fade-in analytics-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Глибока аналітика</h1>
          <p className="page-description">Продажі, витрати та ROI за обраний період; підписки по джерелах лідогенерації</p>
        </div>

        <div className="period-picker">
          <div className="period-seg" role="group" aria-label="Період">
            {([1, 7, 30, 90] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={`period-seg-btn${preset === n ? ' active' : ''}`}
                onClick={() => setPreset(n)}
                aria-pressed={preset === n}
              >
                {n === 1 ? '1 день' : `${n} днів`}
              </button>
            ))}
            <button
              type="button"
              className={`period-seg-btn${preset === 'custom' ? ' active' : ''}`}
              onClick={selectCustomPeriod}
              aria-pressed={preset === 'custom'}
            >
              Період
            </button>
          </div>
          {preset === 'custom' && (
            <div className="crm-date-range">
              <input
                id="analytics-period-from"
                type="date"
                className="input"
                value={customFrom}
                max={customTo || todayUtc()}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="Початок періоду"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
              />
              <span className="crm-date-sep">—</span>
              <input
                id="analytics-period-to"
                type="date"
                className="input"
                value={customTo}
                min={customFrom || undefined}
                max={todayUtc()}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="Кінець періоду"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
              />
            </div>
          )}
          <span className="period-range-note">
            {formatPeriodDate(period.from)} – {formatPeriodDate(period.to)} · {period.days} дн.
            {period.clamped ? ` (максимум ${MAX_PERIOD_DAYS})` : ''}
          </span>
          <span className="live-indicator" title="Нові підписки та етапи воронки підтягуються автоматично">
            <i className="live-dot" aria-hidden="true" />
            Наживо
            {lastUpdated && <> · оновлено {lastUpdated.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</>}
          </span>
        </div>
      </div>

      {kpiError && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>Не вдалося завантажити дані для показників: {kpiError}</span>
        </div>
      )}

      <div className="kpi-grid">
        <KpiCard
          index={0}
          icon={<IconWallet size={16} />}
          label="Сума продажів"
          value={kpiLoading ? '…' : <AnimatedNumber value={sales.total} format={(n) => `${formatMoney(n)} ${baseCurrency}`} />}
          delta={kpiLoading ? null : moneyDelta(sales.total, prevSales.total)}
          spark={kpiLoading ? undefined : salesSpark}
          hint={kpiLoading ? undefined : `${sales.leads} ${sales.leads === 1 ? 'лід' : 'лідів'} на стадії «Продажа»`}
        />
        <KpiCard
          index={1}
          icon={<IconTrendingUp size={16} />}
          label="Витрати на рекламу"
          value={kpiLoading ? '…' : <AnimatedNumber value={spend.total} format={(n) => `${formatMoney(n)} ${baseCurrency}`} />}
          delta={kpiLoading ? null : moneyDelta(spend.total, prevSpend.total)}
          hint={
            kpiLoading ? undefined : (
              <>
                {spend.counted} {spend.counted === 1 ? 'рядок' : 'рядків'} з усіх імпортів, що перетинають період (беруться повністю).
                {spendExclusions.length > 0 && (
                  <span className="kpi-warning">
                    {' '}
                    Не враховано: {spendExclusions.join('; ')}.{' '}
                    <Link to="/dashboard/settings?tab=organization">Курси валют</Link>
                  </span>
                )}
              </>
            )
          }
        />
        <KpiCard
          index={2}
          icon={<IconPercent size={16} />}
          label="Чистий ROI"
          value={kpiLoading ? '…' : roi === null ? '—' : <AnimatedNumber value={roi} format={(n) => `${formatSigned(n, 1)}%`} />}
          delta={
            kpiLoading || roi === null || prevRoi === null
              ? null
              : { text: `${formatSigned(roi - prevRoi, 1)} п.п.`, tone: roi > prevRoi ? 'up' : roi < prevRoi ? 'down' : 'flat' }
          }
          hint={kpiLoading ? undefined : roi === null ? 'Немає витрат за період — ROI не рахується' : '(продажі − витрати) / витрати'}
        />
        <KpiCard
          index={3}
          icon={<IconUsers size={16} />}
          label="Вартість підписника"
          value={kpiLoading ? '…' : cps === null ? '—' : <AnimatedNumber value={cps} format={(n) => `${formatMoney(n)} ${baseCurrency}`} />}
          delta={
            kpiLoading || cps === null || prevCps === null
              ? null
              : (() => {
                  const change = pctChange(cps, prevCps)
                  return change === null ? null : { text: `${formatSigned(change, 1)}%`, tone: change < 0 ? 'up' : change > 0 ? 'down' : 'flat' }
                })()
          }
          hint={
            kpiLoading ? undefined : (
              <>
                {subscribes === 0 ? 'Немає нових підписок за період' : `Витрати / ${subscribes} нових підписок`}
                {spendExclusions.length > 0 && <span className="kpi-warning"> Витрати неповні — див. картку витрат.</span>}
              </>
            )
          }
        />
      </div>

      <div className="analytics-live-row">
        <div className="card analytics-live-card analytics-subs-card" style={{ '--i': 4 } as React.CSSProperties}>
          <div className="kpi-card-top">
            <span className="kpi-label">Підписки / відписки</span>
            <span className="kpi-icon" aria-hidden="true">
              <IconUsers size={16} />
            </span>
          </div>
          <div className="kpi-value">
            {loading ? (
              '…'
            ) : (
              <>
                <span className="analytics-net-positive">
                  +<AnimatedNumber value={totalSubscribes} format={(n) => String(Math.round(n))} />
                </span>
                <span className="kpi-value-sep"> / </span>
                <span className="analytics-net-negative">
                  −<AnimatedNumber value={totalUnsubscribes} format={(n) => String(Math.round(n))} />
                </span>
              </>
            )}
          </div>
          {!loading && <DailyChart days={dailyAll} />}
        </div>

        <div className="card analytics-live-card analytics-channels" style={{ '--i': 5 } as React.CSSProperties}>
          <div className="kpi-card-top">
            <span className="kpi-label">Нові підписники за каналом</span>
            <span className="kpi-icon" aria-hidden="true">
              <IconChat size={16} />
            </span>
          </div>
          {loading ? (
            <div className="kpi-value">…</div>
          ) : (
            <>
              <div className="kpi-value">
                <AnimatedNumber value={channelSplit.total} format={(n) => String(Math.round(n))} />
                <span className="kpi-value-unit"> за період</span>
              </div>
              <ul className="channel-list">
                {channelSplit.slices.map((slice, i) => {
                  const meta = CHANNELS.find((c) => c.key === slice.key)!
                  return (
                    <li
                      key={slice.key}
                      className={`channel-row${i === 0 && slice.count > 0 ? ' is-top' : ''}`}
                      style={{ '--channel': meta.color } as React.CSSProperties}
                    >
                      <span className="channel-row-head">
                        <span className="channel-dot" aria-hidden="true" />
                        <span className="channel-name">{meta.label}</span>
                        <span className="channel-count">
                          {slice.count}
                          <small>{slice.percent.toFixed(0)}%</small>
                        </span>
                      </span>
                      <span className="channel-track">
                        <span className="channel-fill" style={{ width: `${slice.percent}%` }} />
                      </span>
                    </li>
                  )
                })}
                {channelSplit.other > 0 && (
                  <li className="channel-row is-other" style={{ '--channel': 'var(--fg-subtle)' } as React.CSSProperties}>
                    <span className="channel-row-head">
                      <span className="channel-dot" aria-hidden="true" />
                      <span className="channel-name">Інший / невідомий</span>
                      <span className="channel-count">
                        {channelSplit.other}
                        <small>{((channelSplit.other / channelSplit.total) * 100).toFixed(0)}%</small>
                      </span>
                    </span>
                    <span className="channel-track">
                      <span className="channel-fill" style={{ width: `${(channelSplit.other / channelSplit.total) * 100}%` }} />
                    </span>
                  </li>
                )}
              </ul>
            </>
          )}
        </div>

      <div className="card card-tight analytics-live-card analytics-funnel-card" style={{ '--i': 6 } as React.CSSProperties}>
        <div className="analytics-section-header">
          <IconTarget size={16} aria-hidden="true" />
          <h3>Аналітична воронка</h3>
        </div>

        {stageLoading ? (
          <p className="settings-row-hint" style={{ padding: '0 1rem 1rem' }}>
            Завантаження…
          </p>
        ) : stageError ? (
          <div className="alert alert-error" style={{ margin: '0 1rem 1rem' }}>
            <IconAlert size={16} />
            <span>{stageError}</span>
          </div>
        ) : stages.length === 0 ? (
          <div className="empty-state" style={{ border: 'none', background: 'transparent' }}>
            <h3>Ще немає етапів продажу</h3>
            <p>Додайте conversion-вузол у тунель або оберіть етап у профілі ліда.</p>
          </div>
        ) : (
          <>
            <div className="analytics-filter-row" title={`Кількість — унікальні ліди, які досягли етапу в обраний період. Сума — остання зафіксована в цьому періоді сума на етапі по кожному ліду.${selectedFunnelId ? ' Показані лише ліди з посилань цього тунелю — прямі переходи не потрапляють.' : ''}`}>
              <span className="analytics-filter-label">Тунель:</span>
              <select
                className="input stage-funnel-select"
                value={selectedFunnelId}
                onChange={(e) => setSelectedFunnelId(e.target.value)}
                aria-label="Тунель"
              >
                <option value="">Усі тунелі</option>
                {funnels.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="stage-funnel">
              {funnelSteps.map((step, i) => (
                <div className="stage-funnel-step" key={step.id}>
                  <div className="stage-funnel-card" style={{ width: `${step.widthPercent}%` }}>
                    <div className="stage-funnel-card-main">
                      <span className="stage-funnel-name">{step.name}</span>
                      <span className="stage-funnel-sum">{formatMoney(step.total)}</span>
                    </div>
                    <div className="stage-funnel-card-meta">
                      <span className="stage-funnel-count">
                        <AnimatedNumber value={step.leads} format={(n) => String(Math.round(n))} />
                        <small>лідів</small>
                      </span>
                      {step.prevPercent !== null && (
                        <span className={`stage-funnel-conv${step.prevPercent < 100 ? ' is-drop' : ''}`}>
                          {step.prevPercent.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>
                  {i < funnelSteps.length - 1 && <span className="stage-funnel-connector" aria-hidden="true" />}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      </div>

      <div className="card card-tight">
        <div className="analytics-section-header">
          <IconTrendingUp size={16} aria-hidden="true" />
          <h3>Підписки за джерелом</h3>
        </div>

        {loading ? (
          <p className="settings-row-hint" style={{ padding: '0 1rem 1rem' }}>
            Завантаження…
          </p>
        ) : error ? (
          <div className="alert alert-error" style={{ margin: '0 1rem 1rem' }}>
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state" style={{ border: 'none', background: 'transparent' }}>
            <h3>Ще немає лідогенераційних посилань</h3>
            <p>Створіть посилання в розділі «Лідогенерація», щоб побачити статистику підписок тут.</p>
          </div>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Посилання</th>
                  <th>Підписки</th>
                  <th>Відписки</th>
                  <th>Чиста аудиторія</th>
                  <th>Всього лідів</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const expanded = expandedId === row.linkId
                  return (
                    <Fragment key={row.linkId}>
                      <tr className="crm-row" onClick={() => setExpandedId(expanded ? null : row.linkId)}>
                        <td>
                          <span className="analytics-link-name">
                            {expanded ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
                            {row.name}
                          </span>
                        </td>
                        <td>{row.subscribes}</td>
                        <td>{row.unsubscribes}</td>
                        <td className={row.net > 0 ? 'analytics-net-positive' : row.net < 0 ? 'analytics-net-negative' : undefined}>
                          {row.net > 0 ? `+${row.net}` : row.net}
                        </td>
                        <td>{row.totalLeads}</td>
                      </tr>
                      {expanded && (
                        <tr className="analytics-expanded-row">
                          <td colSpan={5}>
                            <DailyChart days={buildDailyBuckets(events, row.linkId, period.from, period.to)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card card-tight analytics-ad-spend-card">
        <div className="analytics-section-header analytics-ad-spend-header">
          <IconUpload size={16} aria-hidden="true" />
          <h3>Витрати на рекламу</h3>
          <label className={`btn btn-secondary analytics-upload-btn${uploading ? ' btn-disabled' : ''}`}>
            {uploading ? <IconSpinner size={15} /> : 'Завантажити CSV'}
            <input type="file" accept=".csv,text/csv" onChange={(e) => void handleFileUpload(e)} disabled={uploading} hidden />
          </label>
        </div>

        {adSpendError && (
          <div className="alert alert-error" style={{ margin: '0 1rem 1rem' }}>
            <IconAlert size={16} />
            <span>{adSpendError}</span>
          </div>
        )}

        {adSpendLoading ? (
          <p className="settings-row-hint" style={{ padding: '0 1rem 1rem' }}>
            Завантаження…
          </p>
        ) : adSpendImports.length === 0 ? (
          <div className="empty-state" style={{ border: 'none', background: 'transparent' }}>
            <h3>Ще немає імпортованих витрат</h3>
            <p>
              Завантажте CSV-звіт з Meta Ads Manager (експортуйте кампанії саме у форматі CSV — Excel-файли поки не
              підтримуються).
            </p>
          </div>
        ) : (
          <>
            {/* The list lives in a modal so this section stays the same height
                whether the org has one import or fifty. */}
            <div className="import-history-row">
              <button type="button" className="btn btn-secondary import-history-btn" onClick={() => setHistoryOpen(true)}>
                <IconHistory size={15} aria-hidden="true" />
                Історія завантажень
                <span className="import-history-count">{adSpendImports.length}</span>
              </button>
              {selectedImport && (
                <span className="settings-row-hint import-history-current">
                  {selectedImport.filename} · {formatDateTime(selectedImport.imported_at)}
                </span>
              )}
            </div>

            <p className="settings-row-hint" style={{ padding: '0 1rem 0.75rem' }}>
              Показані рядки, чий період звіту перетинає обраний угорі сторінки період.
            </p>

            <div className="crm-table-wrap">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Кампанія</th>
                    <th>Статус</th>
                    <th>Період звіту</th>
                    <th>Зіставлене посилання</th>
                    <th>Витрати</th>
                    <th>Результат</th>
                    <th>Ціна за результат</th>
                    <th>CTR</th>
                    <th>Лідів</th>
                    <th>CPL</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAdSpendRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="crm-cell-muted" style={{ textAlign: 'center', padding: '1.25rem' }}>
                        Немає рядків за обраний період.
                      </td>
                    </tr>
                  ) : (
                    visibleAdSpendRows.map((row) => {
                      const leadCount = row.matched_link_id ? (leadCountsByLink.get(row.matched_link_id) ?? 0) : 0
                      const cpl = row.matched_link_id && leadCount > 0 ? row.spend / leadCount : null
                      const results = formatCount(row.results)
                      return (
                        <tr key={row.id}>
                          <td>{row.campaign_name}</td>
                          <td>{row.status_label ?? <span className="crm-cell-muted">—</span>}</td>
                          <td className="crm-cell-muted">{formatPeriod(row.report_start_date, row.report_end_date)}</td>
                          <td>
                            <select
                              className="input analytics-match-select"
                              value={row.matched_link_id ?? ''}
                              onChange={(e) => void handleManualMatch(row.id, e.target.value)}
                              disabled={matchingRowId === row.id}
                              aria-label={`Зіставлене посилання для кампанії ${row.campaign_name}`}
                            >
                              <option value="">— Не зіставлено —</option>
                              {links.map((link) => (
                                <option key={link.id} value={link.id}>
                                  {link.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {row.spend.toFixed(2)}
                            {row.currency ? ` ${row.currency}` : ''}
                            {(() => {
                              const converted = convertSpend(row, baseCurrency, rates)
                              if ('value' in converted) return null
                              return (
                                <span className="badge badge-warning analytics-no-rate">
                                  {converted.excluded === 'no_currency' ? 'немає валюти' : 'немає курсу'}
                                </span>
                              )
                            })()}
                          </td>
                          <td>{results ?? <span className="crm-cell-muted">—</span>}</td>
                          <td>
                            {row.cost_per_result !== null ? (
                              row.cost_per_result.toFixed(2)
                            ) : (
                              <span className="crm-cell-muted">—</span>
                            )}
                          </td>
                          <td>
                            {row.ctr_percent !== null ? (
                              `${row.ctr_percent.toFixed(2)}%`
                            ) : (
                              <span className="crm-cell-muted">—</span>
                            )}
                          </td>
                          <td>{row.matched_link_id ? leadCount : <span className="crm-cell-muted">—</span>}</td>
                          <td>
                            {cpl !== null ? (
                              <>
                                {cpl.toFixed(2)}
                                {row.currency ? ` ${row.currency}` : ''}
                              </>
                            ) : (
                              <span className="crm-cell-muted">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Placeholder only: reserves the slot in the layout. Deliberately inert —
          no handlers, no data, not focusable — until the real AI logic exists. */}
      <div className="card ai-reco-card" aria-disabled="true">
        <div className="ai-reco-head">
          <span className="kpi-icon" aria-hidden="true">
            <IconSparkles size={16} />
          </span>
          <h3>Рекомендації від AI по оптимізації</h3>
          <span className="badge badge-neutral">Незабаром</span>
        </div>
        <ul className="ai-reco-list" aria-label="Приклади майбутніх рекомендацій">
          <li>Кампанія «Літня розпродаж — Instagram» дає найдешевші ліди — варто збільшити бюджет.</li>
          <li>Кампанія «Ретаргетинг — Telegram» витрачає бюджет без продажів за 14 днів — перегляньте аудиторію або зупиніть.</li>
          <li>Ліди з посилання «Вебінар» частіше відписуються на 3-й день — варто змінити повідомлення воронки на цьому кроці.</li>
        </ul>
        <p className="ai-reco-note">Приклад тексту — реальні рекомендації з’являться після запуску функції.</p>
      </div>

      {/* Portalled to document.body, like the delay/condition node modals —
          keeps it clear of any stacking context the cards' own layout
          creates. */}
      {historyOpen &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setHistoryOpen(false)}>
            <div
              className="modal-card modal-card-wide"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Історія завантажень"
            >
              <h3 className="modal-title">Історія завантажень</h3>

              <ul className="import-list">
                {adSpendImports.map((imp) => {
                  const active = imp.id === selectedImportId
                  return (
                    <li key={imp.id} className={`import-item${active ? ' is-active' : ''}`}>
                      <button
                        type="button"
                        className="import-item-main"
                        onClick={() => {
                          setSelectedImportId(imp.id)
                          setHistoryOpen(false)
                        }}
                        aria-pressed={active}
                      >
                        <span className="import-item-name">{imp.filename}</span>
                        <span className="import-item-meta">
                          {formatDateTime(imp.imported_at)} · {rowCounts.get(imp.id) ?? 0} рядків
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost import-item-delete"
                        onClick={() => void handleDeleteImport(imp)}
                        disabled={deletingImportId === imp.id}
                        aria-label={`Видалити імпорт ${imp.filename}`}
                      >
                        {deletingImportId === imp.id ? <IconSpinner size={13} /> : 'Видалити'}
                      </button>
                    </li>
                  )
                })}
              </ul>

              {adSpendImports.length === 0 && (
                <p className="settings-row-hint">Усі імпорти видалено.</p>
              )}

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setHistoryOpen(false)}>
                  Закрити
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
