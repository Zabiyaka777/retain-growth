import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabaseClient'
import { MAX_PERIOD_DAYS, pctChange, previousPeriod, todayUtc, type Period } from '../lib/analyticsFinance'
import {
  formatDuration,
  formatInt,
  formatMoney,
  formatPercent,
  formatPeriodDate,
  usePeriod,
  type PeriodState,
} from '../lib/analyticsFormat'
import {
  IconAlert,
  IconBarChart,
  IconClock,
  IconClose,
  IconEye,
  IconLink,
  IconPercent,
  IconSparkles,
  IconTarget,
  IconUsers,
  IconWallet,
} from './icons'

// ---------- Period (shared by the Аналітика page and the landing popup) ----------

export function PeriodPicker({ state, idPrefix, children }: { state: PeriodState; idPrefix: string; children?: React.ReactNode }) {
  const { preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, period } = state

  function selectCustom() {
    // Opening "Період" starts from whatever range is on screen, not blank inputs.
    if (preset !== 'custom' && !customFrom && !customTo) {
      setCustomFrom(period.from)
      setCustomTo(period.to)
    }
    setPreset('custom')
  }

  return (
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
        <button type="button" className={`period-seg-btn${preset === 'custom' ? ' active' : ''}`} onClick={selectCustom} aria-pressed={preset === 'custom'}>
          Період
        </button>
      </div>
      {preset === 'custom' && (
        <div className="crm-date-range">
          <input
            id={`${idPrefix}-from`}
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
            id={`${idPrefix}-to`}
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
      {children}
    </div>
  )
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })
}

// ---------- Funnel bars (the landing funnel and Аналітична воронка) ----------

export interface FunnelStep {
  key: string
  label: string
  count: number
  /** Optional second figure under the count (a money sum, say). */
  note?: string
}

/**
 * Horizontal bars, each scaled to the first step, with the share kept from
 * the step before. The transition that loses the biggest share of people is
 * marked, so the main drop-off reads at a glance.
 */
export function FunnelBars({ steps, unit = '', compact = false }: { steps: FunnelStep[]; unit?: string; compact?: boolean }) {
  const first = steps[0]?.count ?? 0
  const max = Math.max(1, ...steps.map((s) => s.count))

  let dropIndex = -1
  let dropShare = 0
  steps.forEach((step, i) => {
    if (i === 0) return
    const prev = steps[i - 1].count
    if (prev <= 0) return
    const lost = 1 - step.count / prev
    if (lost > dropShare) {
      dropShare = lost
      dropIndex = i
    }
  })

  return (
    <div className={`fb${compact ? ' is-compact' : ''}`}>
      <ol className="fb-list">
        {steps.map((step, i) => {
          const prev = i > 0 ? steps[i - 1].count : null
          const kept = prev === null ? null : share(step.count, prev)
          const width = step.count > 0 ? Math.max(2.5, (step.count / max) * 100) : 0
          const isDrop = i === dropIndex && dropShare > 0
          return (
            <li key={step.key} className={`fb-step${isDrop ? ' is-drop' : ''}`} style={{ '--i': i } as React.CSSProperties}>
              {i > 0 && (
                <div className="fb-link" aria-hidden={kept === null}>
                  <span className="fb-link-line" />
                  <span className={`fb-link-pill${isDrop ? ' is-drop' : ''}`}>
                    {kept === null ? '—' : `${formatPercent(kept)} далі`}
                  </span>
                </div>
              )}
              <div className="fb-row">
                <span className="fb-idx" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="fb-main">
                  <div className="fb-head">
                    <span className="fb-label">{step.label}</span>
                    <span className="fb-count">
                      {formatInt(step.count)}
                      {unit && <small>{unit}</small>}
                    </span>
                  </div>
                  <div className="fb-track">
                    <span className="fb-fill" style={{ width: `${width}%` }} />
                  </div>
                  {(!compact || step.note) && (
                    <div className="fb-foot">
                      {!compact && <span>{i === 0 ? '100% — точка відліку' : `${formatPercent(share(step.count, first))} від першого кроку`}</span>}
                      {step.note && <span className="fb-note">{step.note}</span>}
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {dropIndex > 0 && (
        <p className="fb-drop-note">
          <IconAlert size={14} aria-hidden="true" />
          {compact ? (
            <span>
              Основний відсів: <b>{steps[dropIndex - 1].label} → {steps[dropIndex].label}</b> (−{formatPercent(dropShare * 100)})
            </span>
          ) : (
            <span>
              Основний відсів: <b>{steps[dropIndex - 1].label}</b> → <b>{steps[dropIndex].label}</b> — далі не проходять{' '}
              <b>{formatPercent(dropShare * 100)}</b>.
            </span>
          )}
        </p>
      )}
    </div>
  )
}

// ---------- Data ----------

interface LandingTotals {
  visitors: number
  views: number
  avg_duration_ms: number
  timed_views: number
  clicks: number
  leads: number
  sales: number
  revenue: number
}

interface LandingDay {
  date: string
  visitors: number
  views: number
  leads: number
  sales: number
}

interface LandingPageStats {
  id: string
  name: string
  slug: string
  status: string
  visitors: number
  views: number
  avg_duration_ms: number
  clicks: number
  leads: number
  sales: number
  revenue: number
}

interface LandingAnalyticsData {
  totals: LandingTotals
  daily: LandingDay[]
  pages: LandingPageStats[]
}

function useLandingAnalytics(period: Period, landingId: string | null) {
  const [data, setData] = useState<LandingAnalyticsData | null>(null)
  const [prev, setPrev] = useState<LandingTotals | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const before = previousPeriod(period)
    // Both windows in one go, so the deltas never pair this period with a stale previous one.
    const [cur, old] = await Promise.all([
      supabase.rpc('landing_analytics', { p_from: period.from, p_to: period.to, p_landing: landingId }),
      supabase.rpc('landing_analytics', { p_from: before.from, p_to: before.to, p_landing: landingId }),
    ])
    return { cur, old }
  }, [period, landingId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const run = () =>
      load().then(({ cur, old }) => {
        if (cancelled) return
        const firstError = cur.error ?? old.error
        if (firstError) setError(firstError.message)
        else {
          setError(null)
          setData(cur.data as LandingAnalyticsData)
          setPrev((old.data as LandingAnalyticsData).totals)
        }
        setLoading(false)
      })
    void run()
    // Visits aren't pushed live; coming back to the tab is when fresh numbers matter.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void run()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, prev, error, loading }
}

function useBaseCurrency() {
  const [currency, setCurrency] = useState('UAH')
  useEffect(() => {
    let cancelled = false
    void supabase
      .from('organizations')
      .select('base_currency')
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data?.base_currency) setCurrency(String(data.base_currency).toUpperCase())
      })
    return () => {
      cancelled = true
    }
  }, [])
  return currency
}

// ---------- Pieces ----------

type Delta = { text: string; tone: 'up' | 'down' | 'flat' } | null

function countDelta(cur: number, old: number | undefined): Delta {
  if (old === undefined) return null
  const change = pctChange(cur, old)
  if (change === null) return null
  const text = `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change).toFixed(0)}%`
  return { text, tone: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' }
}

function pointsDelta(cur: number | null, old: number | null): Delta {
  if (cur === null || old === null) return null
  const diff = cur - old
  const text = `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(diff).toFixed(1)} п.п.`
  return { text, tone: diff > 0.05 ? 'up' : diff < -0.05 ? 'down' : 'flat' }
}

function Tile({
  icon,
  label,
  value,
  sub,
  delta,
  tone,
  index,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  delta: Delta
  tone?: 'accent' | 'ai' | 'success' | 'violet'
  index: number
}) {
  return (
    <div className={`ls-tile tone-${tone ?? 'accent'}`} style={{ '--i': index } as React.CSSProperties}>
      <div className="ls-tile-top">
        <span className="ls-tile-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="ls-tile-label">{label}</span>
      </div>
      <div className="ls-tile-value">
        {value}
        {delta && <span className={`kpi-delta is-${delta.tone}`}>{delta.text}</span>}
      </div>
      {sub && <div className="ls-tile-sub">{sub}</div>}
    </div>
  )
}

const CHART_H = 150
const CHART_PAD = { top: 8, right: 30, bottom: 20, left: 30 }

// A round-ish ceiling so the gridlines land on readable numbers.
function niceCeil(max: number): number {
  const m = Math.max(1, max)
  const step = Math.pow(10, Math.floor(Math.log10(m)))
  return Math.max(4, Math.ceil(m / step) * step)
}

/**
 * Visitors as bars on the left scale; leads (line) and sales (dots) on their
 * own right scale — on a shared one they'd be flattened against the axis,
 * since a landing usually sees many times more visitors than leads.
 */
function TrendChart({ days, height = CHART_H }: { days: LandingDay[]; height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const apply = () => setWidth(el.clientWidth)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ceil = niceCeil(Math.max(...days.map((d) => d.visitors), 0))
  const ceilR = niceCeil(Math.max(...days.map((d) => Math.max(d.leads, d.sales)), 0))
  const innerW = Math.max(0, width - CHART_PAD.left - CHART_PAD.right)
  const innerH = height - CHART_PAD.top - CHART_PAD.bottom
  const slot = days.length > 0 ? innerW / days.length : 0
  const barW = Math.max(1.5, Math.min(22, slot * 0.62))
  const x = (i: number) => CHART_PAD.left + slot * i + slot / 2
  const y = (v: number) => CHART_PAD.top + innerH - (v / ceil) * innerH
  const yR = (v: number) => CHART_PAD.top + innerH - (v / ceilR) * innerH
  const leadPath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${yR(d.leads).toFixed(1)}`).join(' ')
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(innerW / 64))))
  const hovered = hover !== null ? days[hover] : null

  return (
    <div className="ls-chart" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      <div className="ls-chart-legend">
        <span>
          <i className="ls-dot is-visitors" /> Відвідувачі <small>ліва шкала</small>
        </span>
        <span>
          <i className="ls-dot is-leads" /> Ліди
        </span>
        <span>
          <i className="ls-dot is-sales" /> Продажі <small>права шкала</small>
        </span>
      </div>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Відвідувачі, ліди та продажі по днях">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="ls-grid" x1={CHART_PAD.left} x2={width - CHART_PAD.right} y1={y(ceil * f)} y2={y(ceil * f)} />
              <text className="ls-axis" x={CHART_PAD.left - 8} y={y(ceil * f) + 3} textAnchor="end">
                {formatInt(ceil * f)}
              </text>
              <text className="ls-axis is-right" x={width - CHART_PAD.right + 8} y={y(ceil * f) + 3} textAnchor="start">
                {formatInt(ceilR * f)}
              </text>
            </g>
          ))}
          {hover !== null && <rect className="ls-hover-col" x={x(hover) - slot / 2} y={CHART_PAD.top} width={slot} height={innerH} />}
          {days.map((d, i) => {
            const h = (d.visitors / ceil) * innerH
            return (
              <rect
                key={d.date}
                className={`ls-bar${hover === i ? ' is-hover' : ''}`}
                x={x(i) - barW / 2}
                y={CHART_PAD.top + innerH - h}
                width={barW}
                height={Math.max(h, d.visitors > 0 ? 1.5 : 0)}
                rx={Math.min(4, barW / 2)}
              />
            )
          })}
          {days.length > 1 && <path className="ls-line" d={leadPath} />}
          {days.map((d, i) =>
            d.leads > 0 || days.length === 1 ? <circle key={`l${d.date}`} className="ls-line-dot" cx={x(i)} cy={yR(d.leads)} r={hover === i ? 4.5 : 3} /> : null,
          )}
          {days.map((d, i) =>
            d.sales > 0 ? <circle key={`s${d.date}`} className="ls-sale-dot" cx={x(i)} cy={yR(d.sales)} r={hover === i ? 6 : 4.5} /> : null,
          )}
          {days.map((d, i) =>
            i % labelEvery === 0 || i === days.length - 1 ? (
              <text key={`t${d.date}`} className="ls-axis" x={x(i)} y={height - 6} textAnchor="middle">
                {formatDay(d.date)}
              </text>
            ) : null,
          )}
          {days.map((d, i) => (
            <rect
              key={`h${d.date}`}
              className="ls-hit"
              x={x(i) - slot / 2}
              y={0}
              width={slot}
              height={height}
              onMouseEnter={() => setHover(i)}
              onTouchStart={() => setHover(i)}
            />
          ))}
        </svg>
      )}
      {hovered && hover !== null && (
        <div
          className="ls-tooltip"
          style={{ left: Math.min(Math.max(x(hover), 80), width - 80), top: CHART_PAD.top + 22 }}
          role="status"
        >
          <b>{formatDay(hovered.date)}</b>
          <span>
            <i className="ls-dot is-visitors" /> {formatInt(hovered.visitors)} відвід. · {formatInt(hovered.views)} перегл.
          </span>
          <span>
            <i className="ls-dot is-leads" /> {formatInt(hovered.leads)} лідів
          </span>
          <span>
            <i className="ls-dot is-sales" /> {formatInt(hovered.sales)} продажів
          </span>
        </div>
      )}
    </div>
  )
}

// Plain-language reading of the numbers for the landing's owner — only
// statements the data actually supports, nothing generic.
function buildInsights(t: LandingTotals, prev: LandingTotals | null, currency: string): string[] {
  const out: string[] = []
  if (t.views === 0) {
    if (t.clicks > 0 || t.leads > 0) out.push('Перегляди лендінгів почали рахуватись нещодавно — кліки й ліди за ранніші дні вже є, а візитів за них немає.')
    else out.push('За цей період лендінг ніхто не відкривав. Перевірте, що реклама веде саме на його посилання.')
    return out
  }
  const toClick = share(t.clicks, t.visitors)
  const toLead = share(t.leads, t.visitors)
  const toSale = share(t.sales, t.leads)
  if (toClick !== null && toClick < 15)
    out.push(`Лише ${formatPercent(toClick)} відвідувачів натискають кнопку месенджера — варто підсилити заголовок, оффер або підняти кнопку вище.`)
  else if (toClick !== null && toClick >= 35) out.push(`${formatPercent(toClick)} відвідувачів натискають кнопку — сторінка добре переконує.`)
  if (t.clicks > 0 && t.leads / t.clicks < 0.6)
    out.push(`З ${formatInt(t.clicks)} людей, що натиснули кнопку, до бота дійшли лише ${formatInt(t.leads)} — частина губиться між кнопкою та стартом у месенджері.`)
  if (t.avg_duration_ms > 0 && t.avg_duration_ms < 10_000) out.push(`Середній час на сторінці — ${formatDuration(t.avg_duration_ms)}: відвідувачі йдуть швидко, головне має бути на першому екрані.`)
  if (t.views > t.visitors * 1.4) out.push(`Відвідувачі повертаються: у середньому ${(t.views / t.visitors).toFixed(1)} перегляду на людину.`)
  if (t.leads > 0 && t.sales === 0) out.push('Ліди є, продажів поки немає — перевірте, чи доходить тунель до пропозиції.')
  if (t.sales > 0) out.push(`Середній чек з лендінгу — ${formatMoney(t.revenue / t.sales)} ${currency}${toSale !== null ? `, у продаж перетворюється ${formatPercent(toSale)} лідів` : ''}.`)
  if (prev && prev.visitors > 0 && toLead !== null) {
    const prevToLead = share(prev.leads, prev.visitors)
    if (prevToLead !== null && Math.abs(toLead - prevToLead) >= 2)
      out.push(`Конверсія у ліда ${toLead > prevToLead ? 'зросла' : 'впала'} з ${formatPercent(prevToLead)} до ${formatPercent(toLead)} порівняно з попереднім періодом.`)
  }
  return out.slice(0, 4)
}

// ---------- The stats block itself ----------

interface LandingRef {
  id: string
  name: string
  slug?: string
  status?: string
}

interface LandingStatsProps {
  period: Period
  /** null = every landing of the org. */
  landingId: string | null
  /** Shows the landing picker and the per-landing table (dashboard). */
  onLandingChange?: (id: string | null) => void
  variant: 'section' | 'modal'
  /** Section heading, laid out on one row with the landing picker. */
  title?: React.ReactNode
}

export function LandingStats({ period, landingId, onLandingChange, variant, title }: LandingStatsProps) {
  const { data, prev, error, loading } = useLandingAnalytics(period, landingId)
  const currency = useBaseCurrency()
  const [landings, setLandings] = useState<LandingRef[]>([])

  useEffect(() => {
    if (!onLandingChange) return
    let cancelled = false
    void supabase
      .from('landing_pages')
      .select('id, name, slug, status')
      .order('name')
      .then(({ data: rows }) => {
        if (!cancelled) setLandings((rows ?? []) as LandingRef[])
      })
    return () => {
      cancelled = true
    }
  }, [onLandingChange])

  if (error) {
    return (
      <div className="alert alert-error">
        <IconAlert size={16} />
        <span>Не вдалося завантажити статистику лендінгів: {error}</span>
      </div>
    )
  }

  const t = data?.totals
  const toLead = t ? share(t.leads, t.visitors) : null
  const toSale = t ? share(t.sales, t.leads) : null
  const prevToLead = prev ? share(prev.leads, prev.visitors) : null
  const insights = t ? buildInsights(t, prev, currency).slice(0, variant === 'section' ? 3 : 4) : []
  const pages = (data?.pages ?? []).slice().sort((a, b) => b.visitors - a.visitors || b.leads - a.leads)
  const maxVisitors = Math.max(1, ...pages.map((p) => p.visitors))

  return (
    <div className={`ls ls-${variant}${loading && data ? ' is-refreshing' : ''}`}>
      {(title || onLandingChange) && (
        <div className="ls-toolbar">
          {title}
          {onLandingChange && (
            <div className="ls-toolbar-pick">
          <select id="ls-landing" className="input ls-select" aria-label="Лендінг" value={landingId ?? ''} onChange={(e) => onLandingChange(e.target.value || null)}>
            <option value="">Усі лендінги</option>
            {landings.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.status === 'draft' ? ' (чернетка)' : ''}
              </option>
            ))}
          </select>
          {landingId && (
            <button type="button" className="btn btn-ghost ls-reset" onClick={() => onLandingChange(null)}>
              Скинути
            </button>
          )}
            </div>
          )}
        </div>
      )}

      <div className="ls-tiles">
        <Tile
          index={0}
          tone="ai"
          icon={<IconUsers size={15} />}
          label="Відвідувачі"
          value={t ? formatInt(t.visitors) : '…'}
          delta={t ? countDelta(t.visitors, prev?.visitors) : null}
        />
        <Tile
          index={1}
          tone="ai"
          icon={<IconEye size={15} />}
          label="Перегляди"
          value={t ? formatInt(t.views) : '…'}
          sub={t && t.visitors > 0 ? `${(t.views / t.visitors).toFixed(1)} на відвідувача` : undefined}
          delta={t ? countDelta(t.views, prev?.views) : null}
        />
        <Tile
          index={2}
          icon={<IconTarget size={15} />}
          label="Ліди / підписки"
          value={t ? formatInt(t.leads) : '…'}
          sub={t ? `${formatInt(t.clicks)} натиснули кнопку` : undefined}
          delta={t ? countDelta(t.leads, prev?.leads) : null}
        />
        <Tile
          index={3}
          tone="success"
          icon={<IconWallet size={15} />}
          label="Продажі"
          value={t ? formatInt(t.sales) : '…'}
          sub={t && t.revenue > 0 ? `${formatMoney(t.revenue)} ${currency}` : undefined}
          delta={t ? countDelta(t.sales, prev?.sales) : null}
        />
        <Tile
          index={4}
          tone="violet"
          icon={<IconClock size={15} />}
          label="Час на сторінці"
          value={t ? formatDuration(t.avg_duration_ms) : '…'}
          sub={t && t.timed_views > 0 ? `з ${formatInt(t.timed_views)} переглядів` : undefined}
          delta={t && prev && t.avg_duration_ms > 0 && prev.avg_duration_ms > 0 ? countDelta(t.avg_duration_ms, prev.avg_duration_ms) : null}
        />
        <Tile
          index={5}
          icon={<IconPercent size={15} />}
          label="Конверсія в ліда"
          value={t ? formatPercent(toLead) : '…'}
          sub={t ? <>лід → продаж: <b>{formatPercent(toSale)}</b></> : undefined}
          delta={t ? pointsDelta(toLead, prevToLead) : null}
        />
      </div>

      {t && data && (
        <div className="ls-visuals">
          <div className="ls-panel">
            <div className="ls-panel-head">
              <h4>Воронка лендінгу</h4>
              <span className="ls-panel-hint">де відсіюються відвідувачі</span>
            </div>
            <FunnelBars
              compact={variant === 'section'}
              steps={[
                { key: 'visitors', label: 'Відвідали сторінку', count: t.visitors },
                { key: 'clicks', label: 'Натиснули кнопку', count: t.clicks },
                { key: 'leads', label: 'Стали лідами', count: t.leads },
                { key: 'sales', label: 'Купили', count: t.sales, note: t.revenue > 0 ? `${formatMoney(t.revenue)} ${currency}` : undefined },
              ]}
            />
          </div>
          <div className="ls-panel">
            <div className="ls-panel-head">
              <h4>Динаміка по днях</h4>
              <span className="ls-panel-hint">наведіть на день</span>
            </div>
            <TrendChart days={data.daily} height={variant === 'modal' ? 300 : CHART_H} />
          </div>
        </div>
      )}

      {insights.length > 0 && (
        <ul className="ls-insights">
          {insights.map((text) => (
            <li key={text}>
              <IconSparkles size={14} aria-hidden="true" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}

      {onLandingChange && !landingId && pages.length > 1 && (
        <div className="rank">
          <div className="rank-head ls-rank-cols">
            <span>Лендінг</span>
            <span>Відвідувачі</span>
            <span>Ліди</span>
            <span>Конверсія</span>
            <span>Продажі</span>
            <span>Час</span>
          </div>
          {pages.map((p) => {
            const cr = share(p.leads, p.visitors)
            return (
              <button type="button" key={p.id} className="rank-row ls-rank-cols" onClick={() => onLandingChange(p.id)} title="Показати лише цей лендінг">
                <span className="rank-name">
                  <span className="rank-title">{p.name}</span>
                  <span className="rank-bar">
                    <span style={{ width: `${(p.visitors / maxVisitors) * 100}%` }} />
                  </span>
                </span>
                <span className="rank-num" data-label="Відвідувачі">
                  {formatInt(p.visitors)}
                </span>
                <span className="rank-num" data-label="Ліди">
                  {formatInt(p.leads)}
                </span>
                <span className="rank-num" data-label="Конверсія в ліда">
                  <span className={`rank-pill${cr !== null && cr >= 10 ? ' is-good' : ''}`}>{formatPercent(cr)}</span>
                </span>
                <span className="rank-num" data-label="Продажі">
                  {formatInt(p.sales)}
                  {p.revenue > 0 && <small>{formatMoney(p.revenue)}</small>}
                </span>
                <span className="rank-num" data-label="Час">
                  {formatDuration(p.avg_duration_ms)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- Popup on a landing card ----------

export function LandingAnalyticsModal({ landing, onClose }: { landing: LandingRef; onClose: () => void }) {
  const periodState = usePeriod(30)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop ls-modal-backdrop" onClick={onClose}>
      <div className="ls-modal" role="dialog" aria-modal="true" aria-label={`Аналітика: ${landing.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="ls-modal-head">
          <div className="ls-modal-title">
            <span className="ls-modal-icon" aria-hidden="true">
              <IconBarChart size={18} />
            </span>
            <div>
              <h3>{landing.name}</h3>
              <div className="ls-modal-sub">
                {landing.status && (
                  <span className={`badge ${landing.status === 'published' ? 'badge-success' : 'badge-neutral'}`}>
                    {landing.status === 'published' ? 'Опубліковано' : 'Чернетка'}
                  </span>
                )}
                {landing.slug && (
                  <a href={`${window.location.origin}/lp/${landing.slug}`} target="_blank" rel="noopener noreferrer">
                    <IconLink size={12} /> /lp/{landing.slug}
                  </a>
                )}
              </div>
            </div>
          </div>
          <button type="button" className="btn-icon-ghost ls-modal-close" onClick={onClose} aria-label="Закрити">
            <IconClose size={16} />
          </button>
        </div>
        <div className="ls-modal-period">
          <PeriodPicker state={periodState} idPrefix="ls-modal-period" />
        </div>
        <div className="ls-modal-body">
          <LandingStats period={periodState.period} landingId={landing.id} variant="modal" />
          <p className="ls-footnote">
            Відвідувач — унікальний браузер; перегляд — кожне відкриття сторінки (боти й прев'ю посилань не враховуються). Час — лише поки сторінка
            була на екрані. Лід — людина, що перейшла з лендінгу в бота; продаж — такий лід на етапі «Продажа».
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
