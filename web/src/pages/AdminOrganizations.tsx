import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconAlert, IconBuilding, IconChevronRight, IconSearch, IconSpinner, IconTrendingUp, IconUsers, IconWallet } from '../components/icons'
import {
  CHANNEL_LABELS,
  STATUS_META,
  adminOrgsApi,
  formatDate,
  orgInitial,
  relativeTime,
  trialDaysLeft,
  usd,
  type AdminOrgListItem,
  type AdminOrgTotals,
  type PlanStatus,
} from '../lib/adminOrgs'

type StatusFilter = 'all' | PlanStatus | 'none'
type SortKey = 'new' | 'mrr' | 'leads' | 'activity'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'new', label: 'Новіші' },
  { key: 'mrr', label: 'Рахунок' },
  { key: 'leads', label: 'Ліди' },
  { key: 'activity', label: 'Активність' },
]

function Stat({ label, value, sub, tone, icon, index }: { label: string; value: string; sub?: string; tone: string; icon: React.ReactNode; index: number }) {
  return (
    <div className={`adm-stat tone-${tone}`} style={{ '--i': index } as React.CSSProperties}>
      <div className="adm-stat-top">
        <span className="adm-stat-label">{label}</span>
        <span className="adm-stat-icon" aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="adm-stat-value">{value}</div>
      {sub && <div className="adm-stat-sub">{sub}</div>}
    </div>
  )
}

export default function AdminOrganizations() {
  const navigate = useNavigate()
  const [orgs, setOrgs] = useState<AdminOrgListItem[]>([])
  const [totals, setTotals] = useState<AdminOrgTotals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('new')

  useEffect(() => {
    let cancelled = false
    adminOrgsApi<{ organizations: AdminOrgListItem[]; totals: AdminOrgTotals | null }>({ action: 'list' })
      .then((data) => {
        if (cancelled) return
        setOrgs(data.organizations)
        setTotals(data.totals)
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  // The whole list is already here (one tenant = one row), so search, status
  // and sort are instant and don't re-read — and re-log — the platform.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = orgs.filter((o) => {
      if (status !== 'all' && (o.plan_status ?? 'none') !== status) return false
      if (!q) return true
      return o.name.toLowerCase().includes(q) || (o.owner_email ?? '').toLowerCase().includes(q) || o.id.startsWith(q)
    })
    const by: Record<SortKey, (a: AdminOrgListItem, b: AdminOrgListItem) => number> = {
      new: (a, b) => b.created_at.localeCompare(a.created_at),
      mrr: (a, b) => b.bill.net - a.bill.net,
      leads: (a, b) => b.lead_count - a.lead_count,
      activity: (a, b) => (b.last_thread_at ?? '').localeCompare(a.last_thread_at ?? ''),
    }
    return rows.sort(by[sort])
  }, [orgs, query, status, sort])

  const dist = totals ? (['active', 'trial', 'free', 'none'] as const).map((k) => ({ k, n: totals.by_status[k] })) : []

  return (
    <div className="adm fade-in">
      <div className="adm-hero">
        <div>
          <div className="adm-eyebrow">
            <span className="adm-pulse" aria-hidden="true" />
            ROOT ACCESS · MISSION CONTROL
          </div>
          <h1 className="adm-title">Організації</h1>
          <p className="adm-subtitle">Усі тенанти платформи, їхній білінг і стан — лише метадані, без доступу до переписок.</p>
        </div>
        <div className="adm-hero-badges">
          <span className="adm-badge tone-danger">SECURITY ZONE</span>
          <span className="adm-badge tone-active">SYSTEM ONLINE</span>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="adm-stats">
        <Stat index={0} tone="ai" icon={<IconBuilding size={15} />} label="Всього організацій" value={totals ? String(totals.organizations) : '…'} sub={totals ? `+${totals.new_30d} за 30 днів` : undefined} />
        <Stat index={1} tone="active" icon={<IconTrendingUp size={15} />} label="Платні (active)" value={totals ? String(totals.by_status.active) : '…'} sub={totals ? `${totals.active_30d} з активністю за 30 днів` : undefined} />
        <Stat
          index={2}
          tone="trial"
          icon={<IconUsers size={15} />}
          label="На тріалі"
          value={totals ? String(totals.by_status.trial) : '…'}
          sub={totals ? `потенційно ${usd(totals.trial_pipeline)}/міс` : undefined}
        />
        <Stat index={3} tone="accent" icon={<IconWallet size={15} />} label="MRR платформи" value={totals ? usd(totals.mrr) : '…'} sub="сума рахунків active-організацій" />
      </div>

      {totals && totals.organizations > 0 && (
        <div className="adm-dist" aria-label="Розподіл за статусом плану">
          <div className="adm-dist-bar">
            {dist.map(({ k, n }) =>
              n > 0 ? <span key={k} className={`tone-${STATUS_META[k].tone}`} style={{ flex: n }} title={`${STATUS_META[k].label}: ${n}`} /> : null,
            )}
          </div>
          <div className="adm-dist-legend">
            {dist.map(({ k, n }) => (
              <button key={k} type="button" className={`tone-${STATUS_META[k].tone}${status === k ? ' is-on' : ''}`} onClick={() => setStatus(status === k ? 'all' : k)}>
                <i />
                {STATUS_META[k].label} <b>{n}</b>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="adm-panel">
        <div className="adm-toolbar">
          <label className="adm-search">
            <IconSearch size={14} aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Назва, email власника або ID" aria-label="Пошук організації" />
          </label>
          <div className="adm-seg" role="group" aria-label="Статус">
            {(['all', 'active', 'trial', 'free', 'none'] as const).map((k) => (
              <button key={k} type="button" className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}>
                {k === 'all' ? 'Усі' : STATUS_META[k].label}
              </button>
            ))}
          </div>
          <div className="adm-seg" role="group" aria-label="Сортування">
            {SORTS.map((s) => (
              <button key={s.key} type="button" className={sort === s.key ? 'is-on' : ''} onClick={() => setSort(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="adm-loading">
            <IconSpinner size={16} /> Сканую платформу…
          </div>
        ) : visible.length === 0 ? (
          <div className="adm-empty">Нічого не знайдено за цими умовами.</div>
        ) : (
          <div className="adm-list">
            <div className="adm-row adm-row-head">
              <span>Організація</span>
              <span>Статус</span>
              <span>Рахунок / міс</span>
              <span>Ліди</span>
              <span>Активність</span>
              <span>Створена</span>
              <span />
            </div>
            {visible.map((o, i) => {
              const meta = STATUS_META[o.plan_status ?? 'none']
              const days = o.plan_status === 'trial' ? trialDaysLeft(o.trial_ends_at) : null
              return (
                <button
                  type="button"
                  key={o.id}
                  className={`adm-row tone-${meta.tone}`}
                  style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
                  onClick={() => navigate(`/admin/organizations/${o.id}`)}
                >
                  <span className="adm-org">
                    <span className="adm-emblem" aria-hidden="true">
                      {orgInitial(o.name)}
                    </span>
                    <span className="adm-org-text">
                      <b>{o.name}</b>
                      <small>{o.owner_email ?? 'власник невідомий'}</small>
                    </span>
                  </span>
                  <span className="adm-cell" data-label="Статус">
                    <span className={`adm-status tone-${meta.tone}`}>
                      <i />
                      {meta.label}
                      {days !== null && <em>{days} дн</em>}
                    </span>
                  </span>
                  <span className="adm-cell adm-num" data-label="Рахунок / міс">
                    {/* Every org now carries a $29+ gross once formula-priced — 'active' is
                        the only status actually billed for it, so that's the real gate now,
                        not gross > 0 (which used to mean "has any addon enabled"). */}
                    {o.plan_status === 'active' ? (
                      <>
                        {usd(o.bill.net)}
                        <small>
                          {o.bill.subscriberCount.toLocaleString('uk-UA')} підп.{o.bill.discountPct > 0 ? ` · −${o.bill.discountPct}%` : ''}
                        </small>
                      </>
                    ) : (
                      <span className="adm-muted">—</span>
                    )}
                  </span>
                  <span className="adm-cell adm-num" data-label="Ліди">
                    {o.lead_count.toLocaleString('uk-UA')}
                    <small>{o.channels.map((c) => CHANNEL_LABELS[c] ?? c).join(' · ') || 'без каналів'}</small>
                  </span>
                  <span className="adm-cell" data-label="Активність">
                    {relativeTime(o.last_thread_at)}
                  </span>
                  <span className="adm-cell adm-muted" data-label="Створена">
                    {formatDate(o.created_at)}
                  </span>
                  <span className="adm-chevron" aria-hidden="true">
                    <IconChevronRight size={15} />
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
