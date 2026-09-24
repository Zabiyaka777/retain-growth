import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { IconAlert, IconDuplicate, IconEdit, IconFunnel, IconPlus, IconSpinner, IconTrash } from '../components/icons'

interface FunnelRow {
  id: string
  name: string
  is_active: boolean
  created_at: string
}

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export default function Funnels() {
  const navigate = useNavigate()
  const [funnels, setFunnels] = useState<FunnelRow[]>([])
  const [nodeCounts, setNodeCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  async function load() {
    const { data: funnelRows, error: funnelsError } = await supabase
      .from('funnels')
      .select('id, name, is_active, created_at')
      .order('created_at', { ascending: false })

    if (funnelsError) {
      setError(funnelsError.message)
      setLoading(false)
      return
    }

    setFunnels((funnelRows ?? []) as FunnelRow[])

    const { data: nodeRows } = await supabase.from('funnel_nodes').select('funnel_id')
    const counts: Record<string, number> = {}
    for (const row of (nodeRows ?? []) as { funnel_id: string }[]) {
      counts[row.funnel_id] = (counts[row.funnel_id] ?? 0) + 1
    }
    setNodeCounts(counts)
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function handleCreate() {
    setCreating(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setCreating(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-funnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        // funnels.definition belongs to the linear model (funnel-processor.ts v1);
        // graph-model funnels never read it, but save-funnel.ts still requires a
        // valid non-empty definition — this placeholder step satisfies that
        // validation without needing to touch the function itself.
        body: JSON.stringify({
          name: 'Новий тунель',
          definition: [{ type: 'message', text: '—' }],
          isActive: false,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося створити тунель')
        setCreating(false)
        return
      }
      navigate(`/dashboard/funnel-builder/${data.funnel.id}`)
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
      setCreating(false)
    }
  }

  async function handleDuplicate(funnel: FunnelRow) {
    setDuplicatingId(funnel.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDuplicatingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/duplicate-funnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ funnelId: funnel.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося дублювати тунель')
      } else {
        await load()
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDuplicatingId(null)
    }
  }

  // No exclusivity rule: toggling one funnel never affects any other.
  async function handleToggleActive(funnel: FunnelRow) {
    setTogglingId(funnel.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setTogglingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/toggle-funnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ funnelId: funnel.id, isActive: !funnel.is_active }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося змінити статус тунелю')
        return
      }

      await load()
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setTogglingId(null)
    }
  }

  async function handleDelete(funnel: FunnelRow) {
    if (
      !window.confirm(
        `Видалити тунель «${funnel.name}»? Його вузли, активні заходження лідів і пов'язані посилання лідогенерації також буде втрачено.`,
      )
    )
      return
    setDeletingId(funnel.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDeletingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-funnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ funnelId: funnel.id, delete: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося видалити тунель')
      } else {
        setFunnels((prev) => prev.filter((f) => f.id !== funnel.id))
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Тунелі продаж</h1>
          <p className="page-description">Автоматичні сценарії для нових лідів</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={creating} onClick={handleCreate}>
          {creating ? <IconSpinner size={16} /> : <IconPlus size={16} />}
          Новий тунель
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : funnels.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">
            <IconFunnel size={22} />
          </span>
          <h3>Ще немає воронок</h3>
          <p>Створіть тунель і побудуйте граф автоматичних кроків для нових лідів.</p>
        </div>
      ) : (
        <div className="funnel-list">
          {funnels.map((funnel) => (
            <div
              className="card funnel-row"
              key={funnel.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/dashboard/funnel-builder/${funnel.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') navigate(`/dashboard/funnel-builder/${funnel.id}`)
              }}
              style={{ cursor: 'pointer' }}
            >
              <div className="funnel-row-info">
                <span className="funnel-row-name">{funnel.name}</span>
                <span className="funnel-row-meta">{nodeCounts[funnel.id] ?? 0} вузлів</span>
              </div>
              <div className="funnel-row-actions" onClick={(e) => e.stopPropagation()} style={{ gap: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className={`toggle ${funnel.is_active ? 'on' : ''}`}
                    disabled={togglingId === funnel.id}
                    onClick={() => handleToggleActive(funnel)}
                    aria-pressed={funnel.is_active}
                    aria-label={funnel.is_active ? 'Вимкнути тунель' : 'Активувати тунель'}
                    title={funnel.is_active ? 'Активний — клікніть, щоб вимкнути' : 'Неактивний — клікніть, щоб активувати'}
                  >
                    <span className="toggle-knob" />
                  </button>
                  <span className={`badge ${funnel.is_active ? 'badge-success' : 'badge-neutral'}`}>
                    {togglingId === funnel.id ? <IconSpinner size={12} /> : funnel.is_active ? 'Активна' : 'Неактивна'}
                  </span>
                </div>
                <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  <button
                    type="button"
                    className="btn-icon-ghost"
                    onClick={() => navigate(`/dashboard/funnel-builder/${funnel.id}`)}
                    aria-label="Редагувати тунель"
                    title="Редагувати"
                  >
                    <IconEdit size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon-ghost"
                    disabled={duplicatingId === funnel.id}
                    onClick={() => handleDuplicate(funnel)}
                    aria-label="Дублювати тунель"
                    title="Дублювати"
                  >
                    {duplicatingId === funnel.id ? <IconSpinner size={14} /> : <IconDuplicate size={14} />}
                  </button>
                  <button
                    type="button"
                    className="btn-icon-ghost"
                    disabled={deletingId === funnel.id}
                    onClick={() => handleDelete(funnel)}
                    aria-label="Видалити тунель"
                    title="Видалити"
                  >
                    {deletingId === funnel.id ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
