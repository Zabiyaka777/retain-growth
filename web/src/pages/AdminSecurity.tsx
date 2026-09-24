import { Fragment, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { IconAlert, IconChevronDown, IconChevronUp, IconSpinner, IconSync } from '../components/icons'
import { describeEvent, SEVERITY_LABELS, type Severity } from '../lib/eventCatalog'

interface AdminEvent {
  id: string
  org_id: string
  type: string
  level: string
  payload: Record<string, unknown>
  created_at: string
}

interface OrgOption {
  id: string
  name: string
}

const LEVELS = [
  { value: '', label: 'Усі рівні' },
  { value: 'error', label: 'Помилки' },
  { value: 'warn', label: 'Попередження' },
  { value: 'info', label: 'Інфо' },
]

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: 'badge badge-danger',
  warning: 'badge badge-warning',
  info: 'badge badge-neutral',
}

const SEVERITY_SHORT: Record<Severity, string> = {
  critical: 'критично',
  warning: 'увага',
  info: 'інфо',
}

const DAY_MS = 24 * 60 * 60 * 1000
// The counter reads an unfiltered page of its own; this is that page's size,
// and the point past which the number is reported as "N+" rather than
// pretending to be exact.
const SUMMARY_LIMIT = 500

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export default function AdminSecurity() {
  const [events, setEvents] = useState<AdminEvent[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [orgNames, setOrgNames] = useState<Record<string, string>>({})
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [type, setType] = useState('')
  const [level, setLevel] = useState('')
  const [orgId, setOrgId] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [summary, setSummary] = useState<{ counts: Record<Severity, number>; capped: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setLoading(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/admin-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ type, level, orgId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося отримати події')
      } else {
        setEvents((data.events ?? []) as AdminEvent[])
        setTypes((data.types ?? []) as string[])
        setOrgNames((data.orgNames ?? {}) as Record<string, string>)
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setLoading(false)
    }
  }, [type, level, orgId])

  useEffect(() => {
    void load()
  }, [load])

  // Deliberately unfiltered and separate from the table's own query: the
  // headline is "how is the platform doing right now", which must not change
  // when the operator narrows the list below to one org or one type.
  const loadSummary = useCallback(async () => {
    const accessToken = await getAccessToken()
    if (!accessToken) return

    try {
      const res = await fetch('/.netlify/functions/admin-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ limit: SUMMARY_LIMIT }),
      })
      const data = await res.json()
      if (!res.ok) return

      const rows = (data.events ?? []) as AdminEvent[]
      const since = Date.now() - DAY_MS
      const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 }
      for (const ev of rows) {
        if (new Date(ev.created_at).getTime() < since) continue
        counts[describeEvent(ev.type, ev.level).severity] += 1
      }
      // A full page back means older events may have been cut off, so the
      // 24h window can't be counted exactly from it.
      setSummary({ counts, capped: rows.length === SUMMARY_LIMIT })
    } catch {
      // The headline is a convenience; the table below is the real content.
    }
  }, [])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  // The org filter needs every org, not just the ones in the current result
  // set — otherwise filtering to a quiet org would be impossible.
  useEffect(() => {
    async function loadOrgs() {
      const accessToken = await getAccessToken()
      if (!accessToken) return
      const res = await fetch('/.netlify/functions/admin-organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ search: '' }),
      })
      const data = await res.json()
      if (res.ok) setOrgOptions(((data.organizations ?? []) as OrgOption[]).map((o) => ({ id: o.id, name: o.name })))
    }
    void loadOrgs()
  }, [])

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Безпека</h1>
          <p className="page-description">Системні події по всій платформі — відхилені вебхуки, збої інтеграцій, помилки AI</p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {summary && (
        <div className="admin-summary">
          <span className="admin-summary-label">За останню добу:</span>
          {(['critical', 'warning', 'info'] as Severity[]).map((sev) => (
            <span key={sev} className={`admin-summary-pill is-${sev}${summary.counts[sev] === 0 ? ' is-empty' : ''}`}>
              <strong>
                {summary.counts[sev]}
                {summary.capped && sev === 'critical' ? '+' : ''}
              </strong>{' '}
              {SEVERITY_LABELS[sev]}
            </span>
          ))}
          {summary.counts.critical === 0 && summary.counts.warning === 0 && (
            <span className="admin-summary-ok">Все спокійно</span>
          )}
        </div>
      )}

      <div className="analytics-filter-row">
        <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label="Тип події">
          <option value="">Усі типи</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <select className="input" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Рівень">
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>

        <select className="input" value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Організація">
          <option value="">Усі організації</option>
          {orgOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void load()
            void loadSummary()
          }}
          disabled={loading}
        >
          {loading ? <IconSpinner size={15} /> : <IconSync size={15} />}
          Оновити
        </button>
      </div>

      <div className="card card-tight">
        {loading ? (
          <p className="settings-row-hint" style={{ padding: '0 1rem 1rem' }}>
            Завантаження…
          </p>
        ) : events.length === 0 ? (
          <div className="empty-state" style={{ border: 'none', background: 'transparent' }}>
            <h3>Подій не знайдено</h3>
            <p>За обраними фільтрами немає записів.</p>
          </div>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Час</th>
                  <th>Рівень</th>
                  <th>Подія</th>
                  <th>Організація</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => {
                  const info = describeEvent(ev.type, ev.level)
                  const expanded = expandedId === ev.id
                  return (
                    <Fragment key={ev.id}>
                      <tr className="crm-row" onClick={() => setExpandedId(expanded ? null : ev.id)}>
                        <td className="crm-cell-muted">{formatDateTime(ev.created_at)}</td>
                        <td>
                          <span className={SEVERITY_BADGE[info.severity]}>{SEVERITY_SHORT[info.severity]}</span>
                        </td>
                        <td>
                          <span className="admin-event-name">
                            {expanded ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
                            {info.title}
                          </span>
                          {/* Kept for debugging: the operator reads the title,
                              but a bug report needs the raw type. */}
                          <span className="admin-event-type">{ev.type}</span>
                        </td>
                        <td className="crm-cell-muted">{orgNames[ev.org_id] ?? ev.org_id.slice(0, 8)}</td>
                      </tr>
                      {expanded && (
                        <tr className="analytics-expanded-row">
                          <td colSpan={4}>
                            <p className="admin-event-explanation">{info.explanation}</p>
                            <code className="admin-event-payload">{JSON.stringify(ev.payload, null, 1)}</code>
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
    </div>
  )
}
