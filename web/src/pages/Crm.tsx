import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { CHANNELS } from '../components/LeadGenLinks'
import LeadProfile from '../components/LeadProfile'
import LeadIndicatorIcons from '../components/LeadIndicatorIcons'
import { useLeadIndicators } from '../hooks/useLeadIndicators'
import { leadDisplayName } from '../lib/leadDisplayName'
import {
  IconAlert,
  IconArchiveBox,
  IconChat,
  IconChevronDown,
  IconChevronUp,
  IconSearch,
  IconSpinner,
  IconUsers,
} from '../components/icons'

type LeadStatus = 'active' | 'blocked' | 'archived'

// Sortable columns only — every one is NOT NULL on the view, so keyset
// pagination (.lt/.gt on the cursor value) never has to reason about nulls.
// username/tags/source are shown but not sortable: username can be null and
// tags/source are multi-valued, neither of which "sort" cleanly.
type SortColumn = 'created_at' | 'last_active_at' | 'status' | 'channel_type'
type SortDirection = 'asc' | 'desc'

const PAGE_SIZE = 25
const DATE_COLUMNS = new Set<SortColumn>(['created_at', 'last_active_at'])

function defaultDirectionFor(col: SortColumn): SortDirection {
  return DATE_COLUMNS.has(col) ? 'desc' : 'asc'
}

interface LeadDirectoryRow {
  id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  external_id: string
  channel_type: string
  status: LeadStatus
  created_at: string
  source_link_id: string | null
  source_name: string | null
  last_active_at: string
  latest_thread_id: string | null
  tag_ids: string[]
  tag_names: string[]
  subscribed: boolean
}

interface TagOption {
  id: string
  name: string
}

interface LinkOption {
  id: string
  name: string
}

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

function leadLabel(row: LeadDirectoryRow): string {
  return leadDisplayName(row)
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const STATUS_LABELS: Record<LeadStatus, string> = { active: 'Активний', blocked: 'Заблокований', archived: 'Архів' }
const STATUS_BADGE_CLASS: Record<LeadStatus, string> = { active: 'badge-success', blocked: 'badge-danger', archived: 'badge-neutral' }

export default function Crm() {
  // Archive is a separate view, not just another status filter value — an
  // archived lead never appears in the default list regardless of what else
  // is selected, and the reverse (unarchive) action only makes sense here.
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null)
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null)

  const [tags, setTags] = useState<TagOption[]>([])
  const [links, setLinks] = useState<LinkOption[]>([])

  const [statusFilter, setStatusFilter] = useState<'' | LeadStatus>('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [sourceFilter, setSourceFilter] = useState('') // '' = all, 'none' = no source, else a lead_gen_links id
  const [channelFilter, setChannelFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')

  const [sortColumn, setSortColumn] = useState<SortColumn>('created_at')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const [rows, setRows] = useState<LeadDirectoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)

  // The lead a row-click opened a profile modal for — null means no modal.
  // threadId travels alongside it since the modal needs it for both the
  // "close thread" action inside LeadProfile and the "Відкрити чат" link.
  const [modalLead, setModalLead] = useState<{ leadId: string; threadId: string } | null>(null)

  useEffect(() => {
    supabase
      .from('tags')
      .select('id, name')
      .order('name')
      .then(({ data }) => setTags((data ?? []) as TagOption[]))
    supabase
      .from('lead_gen_links')
      .select('id, name')
      .order('name')
      .then(({ data }) => setLinks((data ?? []) as LinkOption[]))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  function buildQuery() {
    let q = supabase.from('leads_directory').select('*')
    if (view === 'archived') {
      // Overrides statusFilter entirely — the archive view only ever shows
      // archived leads, and the status dropdown is hidden while it's active.
      q = q.eq('status', 'archived')
    } else if (statusFilter) {
      q = q.eq('status', statusFilter)
    } else {
      // No status chosen still must not leak archived leads into "all".
      q = q.neq('status', 'archived')
    }
    if (tagFilter.length > 0) q = q.overlaps('tag_ids', tagFilter)
    if (sourceFilter === 'none') q = q.is('source_link_id', null)
    else if (sourceFilter) q = q.eq('source_link_id', sourceFilter)
    if (channelFilter) q = q.eq('channel_type', channelFilter)
    if (dateFrom) q = q.gte('created_at', dateFrom)
    if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59.999`)
    if (searchDebounced) {
      // PostgREST's .or() DSL treats ',' and '(' ')' as structural — strip
      // them from free-text input rather than trying to escape them.
      const term = searchDebounced.replace(/[,()]/g, '')
      if (term) q = q.or(`username.ilike.%${term}%,external_id.ilike.%${term}%`)
    }
    return q.order(sortColumn, { ascending: sortDirection === 'asc' })
  }

  // Re-runs page 1 whenever any filter or the sort changes — same
  // cursor-reset-on-change shape as Chats.tsx's own thread list, just
  // parameterized over more filters and a variable sort column.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setCursor(null)
    setHasMore(true)

    buildQuery()
      .limit(PAGE_SIZE)
      .then(({ data, error: queryError }) => {
        if (cancelled) return
        if (queryError) {
          setError(queryError.message)
          setRows([])
        } else {
          const list = (data ?? []) as LeadDirectoryRow[]
          setRows(list)
          const last = list[list.length - 1]
          setCursor(last ? String(last[sortColumn]) : null)
          setHasMore(list.length === PAGE_SIZE)
        }
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, statusFilter, tagFilter, sourceFilter, channelFilter, dateFrom, dateTo, searchDebounced, sortColumn, sortDirection])

  async function loadMore() {
    if (!cursor || !hasMore || loadingMore) return
    setLoadingMore(true)

    let q = buildQuery()
    q = sortDirection === 'asc' ? q.gt(sortColumn, cursor) : q.lt(sortColumn, cursor)
    const { data, error: queryError } = await q.limit(PAGE_SIZE)

    if (!queryError && data) {
      const list = data as LeadDirectoryRow[]
      setRows((prev) => [...prev, ...list])
      const last = list[list.length - 1]
      setCursor(last ? String(last[sortColumn]) : cursor)
      setHasMore(list.length === PAGE_SIZE)
    }
    setLoadingMore(false)
  }

  function handleSort(col: SortColumn) {
    if (col === sortColumn) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(col)
      setSortDirection(defaultDirectionFor(col))
    }
  }

  function toggleTagFilter(tagId: string) {
    setTagFilter((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]))
  }

  function handleRowClick(row: LeadDirectoryRow) {
    if (!row.latest_thread_id) return
    setModalLead({ leadId: row.id, threadId: row.latest_thread_id })
  }

  // Same visibility rule buildQuery() already applies server-side: an
  // archived lead has no place in the "active" view, so a block/archive from
  // inside the modal drops the row here instead of leaving a stale one that
  // would vanish on the next fetch anyway.
  function handleModalLeadStatusChange(leadId: string, status: 'blocked' | 'archived') {
    setRows((prev) => {
      if (status === 'archived' && view === 'active') return prev.filter((r) => r.id !== leadId)
      return prev.map((r) => (r.id === leadId ? { ...r, status } : r))
    })
  }

  // Permanent deletion — the row is gone from the database, not just
  // recategorized, so it drops out of every view (not just the current one
  // like the archive case above) and the modal closes.
  function handleModalLeadDeleted(leadId: string) {
    setRows((prev) => prev.filter((r) => r.id !== leadId))
    setModalLead(null)
  }

  async function handleUnarchive(row: LeadDirectoryRow) {
    setUnarchiveError(null)
    setUnarchivingId(row.id)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setUnarchiveError('Сесія недійсна, увійдіть знову')
      setUnarchivingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/update-lead-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId: row.id, status: 'active' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setUnarchiveError(data.error ?? 'Не вдалося розархівувати ліда')
      } else {
        // No longer archived, so it has no place in this view — drop it
        // rather than refetch the whole page for one row.
        setRows((prev) => prev.filter((r) => r.id !== row.id))
      }
    } catch {
      setUnarchiveError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setUnarchivingId(null)
    }
  }

  function SortHeader({ col, children }: { col: SortColumn; children: React.ReactNode }) {
    const active = sortColumn === col
    return (
      <th>
        <button type="button" className={`crm-sort-header${active ? ' active' : ''}`} onClick={() => handleSort(col)}>
          {children}
          {active && (sortDirection === 'asc' ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />)}
        </button>
      </th>
    )
  }

  const activeFilterCount =
    (statusFilter ? 1 : 0) + tagFilter.length + (sourceFilter ? 1 : 0) + (channelFilter ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0)

  const leadIndicators = useLeadIndicators(rows.map((r) => r.id))

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">CRM</h1>
          <p className="page-description">Усі ліди організації — статус, теги, джерело, активність</p>
        </div>
      </div>

      <div className="tabs">
        <button type="button" className={`tab-trigger${view === 'active' ? ' active' : ''}`} onClick={() => setView('active')}>
          <IconUsers size={15} />
          Ліди
        </button>
        <button type="button" className={`tab-trigger${view === 'archived' ? ' active' : ''}`} onClick={() => setView('archived')}>
          <IconArchiveBox size={15} />
          Архів
        </button>
      </div>

      <div className="card crm-toolbar">
        <div className="crm-toolbar-row">
          <div className="crm-search">
            <IconSearch size={15} aria-hidden="true" />
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Пошук за username або ID…"
              aria-label="Пошук лідів"
            />
          </div>

          {view === 'active' && (
            // No "Архів" option here — archived leads have their own tab and
            // never appear in this view no matter what's selected below.
            <select
              className="input crm-filter-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | LeadStatus)}
              aria-label="Фільтр за статусом"
            >
              <option value="">Усі статуси</option>
              <option value="active">Активний</option>
              <option value="blocked">Заблокований</option>
            </select>
          )}

          <select className="input crm-filter-select" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} aria-label="Фільтр за каналом">
            <option value="">Усі канали</option>
            {CHANNELS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>

          <select className="input crm-filter-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="Фільтр за джерелом">
            <option value="">Усі джерела</option>
            <option value="none">Прямий перехід</option>
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>

          <div className="crm-date-range">
            <input
              id="crm-date-from"
              type="date"
              className="input"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Дата реєстрації від"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            />
            <span className="crm-date-sep">—</span>
            <input
              id="crm-date-to"
              type="date"
              className="input"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Дата реєстрації до"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            />
          </div>

          {activeFilterCount > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setStatusFilter('')
                setTagFilter([])
                setSourceFilter('')
                setChannelFilter('')
                setDateFrom('')
                setDateTo('')
                setSearch('')
              }}
            >
              Скинути фільтри
            </button>
          )}
        </div>

        {tags.length > 0 && (
          <div className="crm-tag-filters">
            <span className="crm-tag-filters-label">Теги:</span>
            {tags.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`badge crm-tag-toggle${tagFilter.includes(t.id) ? ' active' : ''}`}
                aria-pressed={tagFilter.includes(t.id)}
                onClick={() => toggleTagFilter(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {unarchiveError && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{unarchiveError}</span>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">
            {view === 'archived' ? <IconArchiveBox size={22} /> : <IconUsers size={22} />}
          </span>
          <h3>{view === 'archived' ? 'В архіві нікого немає' : 'Нічого не знайдено'}</h3>
          <p>
            {view === 'archived'
              ? 'Архівовані ліди зникають зі стандартного списку, але завжди доступні тут.'
              : 'Спробуйте змінити фільтри або пошуковий запит.'}
          </p>
        </div>
      ) : (
        <div className="card card-tight crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr>
                <th>Лід</th>
                <SortHeader col="channel_type">Канал</SortHeader>
                <SortHeader col="status">Статус</SortHeader>
                <th>Теги</th>
                <th>Джерело</th>
                <SortHeader col="created_at">Реєстрація</SortHeader>
                <SortHeader col="last_active_at">Остання активність</SortHeader>
                {view === 'archived' && <th>Дії</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const channel = CHANNELS.find((c) => c.key === row.channel_type)
                const ChannelIcon = channel?.icon
                const visibleTags = row.tag_names.slice(0, 2)
                const extraTags = row.tag_names.length - visibleTags.length
                return (
                  <tr
                    key={row.id}
                    className={`crm-row${row.subscribed ? '' : ' crm-row-unsubscribed'}`}
                    onClick={() => handleRowClick(row)}
                  >
                    <td>
                      <div className="crm-lead-cell">
                        <span className="thread-avatar">{leadLabel(row).slice(0, 1).replace('@', '')}</span>
                        <span>{leadLabel(row)}</span>
                        <LeadIndicatorIcons entry={leadIndicators[row.id]} />
                      </div>
                    </td>
                    <td>
                      <span className="crm-channel-cell">
                        {ChannelIcon && <ChannelIcon size={14} aria-hidden="true" />}
                        {channel?.label ?? row.channel_type}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE_CLASS[row.status]}`}>{STATUS_LABELS[row.status]}</span>
                    </td>
                    <td>
                      {row.tag_names.length === 0 ? (
                        <span className="crm-cell-muted">—</span>
                      ) : (
                        <div className="crm-tags-cell">
                          {visibleTags.map((name) => (
                            <span key={name} className="badge badge-tag">
                              {name}
                            </span>
                          ))}
                          {extraTags > 0 && <span className="badge badge-neutral">+{extraTags}</span>}
                        </div>
                      )}
                    </td>
                    <td>{row.source_name ?? <span className="crm-cell-muted">Прямий перехід</span>}</td>
                    <td className="crm-cell-muted">{formatDateTime(row.created_at)}</td>
                    <td className="crm-cell-muted">{formatDateTime(row.last_active_at)}</td>
                    {view === 'archived' && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={unarchivingId === row.id}
                          onClick={() => handleUnarchive(row)}
                        >
                          {unarchivingId === row.id ? <IconSpinner size={14} /> : 'Розархівувати'}
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>

          {hasMore && (
            <div className="crm-load-more">
              <button type="button" className="btn btn-secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <IconSpinner size={15} /> : 'Завантажити ще'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Portalled to <body>, same approach as the funnel builder's node
          config modals — keeps this clear of any stacking-context quirks
          from the table's own scroll container regardless of page layout. */}
      {modalLead &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setModalLead(null)}>
            <div
              className="modal-card modal-card-wide"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Профіль ліда"
            >
              <LeadProfile
                leadId={modalLead.leadId}
                threadId={modalLead.threadId}
                onClose={() => setModalLead(null)}
                onLeadStatusChange={handleModalLeadStatusChange}
                onDeleted={handleModalLeadDeleted}
              />

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setModalLead(null)}>
                  Закрити
                </button>
                <Link to={`/dashboard/chats?thread=${modalLead.threadId}`} className="btn btn-primary">
                  <IconChat size={16} />
                  Відкрити чат
                </Link>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
