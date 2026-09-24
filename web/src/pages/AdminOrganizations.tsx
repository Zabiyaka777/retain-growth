import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { IconAlert, IconSearch, IconSpinner, IconTrash } from '../components/icons'

interface AdminOrg {
  id: string
  name: string
  created_at: string
  lead_count: number
  channels: string[]
  last_thread_at: string | null
}

interface OrgDiscount {
  id: string
  label: string
  percent: number
  expires_at: string | null
  created_at: string
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  fbm: 'Messenger',
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export default function AdminOrganizations() {
  const [orgs, setOrgs] = useState<AdminOrg[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<AdminOrg | null>(null)

  async function load(searchTerm: string) {
    setLoading(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setLoading(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/admin-organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ search: searchTerm }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Не вдалося отримати список організацій')
      else setOrgs((data.organizations ?? []) as AdminOrg[])
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('')
  }, [])

  function handleSearch(e: FormEvent) {
    e.preventDefault()
    void load(search)
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Організації</h1>
          <p className="page-description">Огляд усіх тенантів платформи — лише метадані, без доступу в самі кабінети</p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <form className="analytics-filter-row" onSubmit={handleSearch}>
        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Пошук за назвою…"
          aria-label="Пошук організації"
        />
        <button type="submit" className="btn btn-secondary" disabled={loading}>
          {loading ? <IconSpinner size={15} /> : <IconSearch size={15} />}
          Знайти
        </button>
        {search && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setSearch('')
              void load('')
            }}
          >
            Скинути
          </button>
        )}
      </form>

      <div className="card card-tight">
        {loading ? (
          <p className="settings-row-hint" style={{ padding: '0 1rem 1rem' }}>
            Завантаження…
          </p>
        ) : orgs.length === 0 ? (
          <div className="empty-state" style={{ border: 'none', background: 'transparent' }}>
            <h3>Нічого не знайдено</h3>
            <p>За цим запитом немає організацій.</p>
          </div>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Організація</th>
                  <th>Створена</th>
                  <th>Лідів</th>
                  <th>Канали</th>
                  <th>Остання активність</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id} className="crm-row" onClick={() => setSelected(org)}>
                    <td>{org.name}</td>
                    <td className="crm-cell-muted">{formatDate(org.created_at)}</td>
                    <td>{org.lead_count}</td>
                    <td>
                      {org.channels.length === 0 ? (
                        <span className="crm-cell-muted">—</span>
                      ) : (
                        org.channels.map((c) => (
                          <span key={c} className="badge badge-neutral" style={{ marginRight: '0.25rem' }}>
                            {CHANNEL_LABELS[c] ?? c}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="crm-cell-muted">{formatDate(org.last_thread_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <div className="card admin-detail">
          <div className="admin-detail-head">
            <h3>{selected.name}</h3>
            <button type="button" className="btn btn-ghost" onClick={() => setSelected(null)}>
              Закрити
            </button>
          </div>
          <dl className="admin-detail-grid">
            <div>
              <dt>ID</dt>
              <dd className="admin-detail-mono">{selected.id}</dd>
            </div>
            <div>
              <dt>Створена</dt>
              <dd>{formatDate(selected.created_at)}</dd>
            </div>
            <div>
              <dt>Лідів</dt>
              <dd>{selected.lead_count}</dd>
            </div>
            <div>
              <dt>Підключені канали</dt>
              <dd>{selected.channels.map((c) => CHANNEL_LABELS[c] ?? c).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>Останній активний тред</dt>
              <dd>{formatDate(selected.last_thread_at)}</dd>
            </div>
          </dl>
          <p className="settings-row-hint">
            Тільки метадані. Переписки, ліди й креденшели цієї організації звідси недоступні.
          </p>

          <DiscountsSection orgId={selected.id} />
        </div>
      )}
    </div>
  )
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function isExpired(discount: OrgDiscount): boolean {
  return !!discount.expires_at && new Date(discount.expires_at).getTime() < Date.now()
}

// Platform-admin-only view/edit of org_discounts for one org — a modifier
// layered on top of the client's own billing calculation, never touching
// org_billing_state/org_billing_addons themselves.
function DiscountsSection({ orgId }: { orgId: string }) {
  const [discounts, setDiscounts] = useState<OrgDiscount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [percent, setPercent] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function callDiscountApi(body: Record<string, unknown>) {
    const accessToken = await getAccessToken()
    if (!accessToken) throw new Error('Сесія недійсна, увійдіть знову')

    const res = await fetch('/.netlify/functions/save-org-discount', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Не вдалося виконати дію')
    return data
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await callDiscountApi({ action: 'list', orgId })
      setDiscounts((data.discounts ?? []) as OrgDiscount[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося отримати знижки')
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    void load()
    setLabel('')
    setPercent('')
    setExpiresAt('')
  }, [orgId, load])

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    const percentNum = Number(percent)
    if (!label.trim() || Number.isNaN(percentNum) || percentNum < 0 || percentNum > 100) {
      setError('Вкажіть назву й відсоток від 0 до 100')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await callDiscountApi({
        action: 'create',
        orgId,
        label: label.trim(),
        percent: percentNum,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      })
      setLabel('')
      setPercent('')
      setExpiresAt('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося створити знижку')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(discountId: string) {
    setDeletingId(discountId)
    setError(null)
    try {
      await callDiscountApi({ action: 'delete', orgId, discountId })
      setDiscounts((prev) => prev.filter((d) => d.id !== discountId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося видалити знижку')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={{ marginTop: '1.25rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)' }}>
      <h4 style={{ margin: '0 0 0.75rem' }}>Знижки</h4>

      {loading ? (
        <p className="settings-row-hint">Завантаження…</p>
      ) : discounts.length === 0 ? (
        <p className="settings-row-hint">Знижок для цієї організації ще немає.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: '0 0 1rem', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {discounts.map((d) => {
            const expired = isExpired(d)
            return (
              <li
                key={d.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  padding: '0.625rem 0.75rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  opacity: expired ? 0.55 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', minWidth: 0 }}>
                  <span className={`badge ${expired ? 'badge-neutral' : 'badge-success'}`}>−{d.percent}%</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
                  {d.expires_at && (
                    <span className="settings-row-hint">
                      {expired ? 'прострочено' : 'до'} {formatShortDate(d.expires_at)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: '0.375rem' }}
                  onClick={() => handleDelete(d.id)}
                  disabled={deletingId === d.id}
                  aria-label={`Видалити знижку ${d.label}`}
                >
                  {deletingId === d.id ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <form onSubmit={handleAdd} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' }}>
        <div style={{ flex: '2 1 200px' }}>
          <label className="settings-row-hint" htmlFor="discount-label" style={{ display: 'block', marginBottom: '0.25rem' }}>
            Назва
          </label>
          <input
            id="discount-label"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Знижка для раннього клієнта"
          />
        </div>
        <div style={{ flex: '1 1 90px' }}>
          <label className="settings-row-hint" htmlFor="discount-percent" style={{ display: 'block', marginBottom: '0.25rem' }}>
            Відсоток
          </label>
          <input
            id="discount-percent"
            className="input"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            placeholder="20"
          />
        </div>
        <div style={{ flex: '1 1 150px' }}>
          <label className="settings-row-hint" htmlFor="discount-expires" style={{ display: 'block', marginBottom: '0.25rem' }}>
            Діє до (опційно)
          </label>
          <input id="discount-expires" className="input" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={submitting}>
          {submitting ? <IconSpinner size={15} /> : 'Додати знижку'}
        </button>
      </form>

      {error && (
        <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
