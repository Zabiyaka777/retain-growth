import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { ChannelCopyButtons } from '../components/LeadGenLinks'
import { IconAlert, IconDuplicate, IconEdit, IconLink, IconPlus, IconSpinner, IconTrash } from '../components/icons'
import { LandingTemplate, withConfigDefaults, TEMPLATE_META, type LandingConfig, type LandingTemplateKey } from '../components/LandingTemplates'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

interface LeadGenLinkRow {
  id: string
  name: string
  ref_token: string
  funnel_id: string
  entry_node_id: string | null
  created_at: string
  funnels: { name: string } | null
  funnel_nodes: { config: { label?: string } | null } | null
}

interface LandingRow {
  id: string
  org_id: string
  name: string
  template_key: LandingTemplateKey
  slug: string
  status: 'draft' | 'published'
  config: Partial<LandingConfig> | null
  funnel_id: string | null
  entry_node_id: string | null
  funnels: { name: string } | null
}

// The thumbnail renders the real template at phone width and shrinks it to
// whatever the card ended up being, so the preview stays pixel-accurate at
// any column count instead of leaving a gap at a hardcoded scale.
const THUMB_WIDTH = 390
function Thumb({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = () => el.style.setProperty('--lp-thumb-scale', String(el.clientWidth / THUMB_WIDTH))
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <span className="lp-card-view" ref={ref}>
      <div className="lp-card-scale">{children}</div>
    </span>
  )
}

export default function LeadGenTools() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'landings' ? 'landings' : 'links'
  const [landings, setLandings] = useState<LandingRow[]>([])
  const [landingsLoading, setLandingsLoading] = useState(true)
  const [links, setLinks] = useState<LeadGenLinkRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [duplicatingLandingId, setDuplicatingLandingId] = useState<string | null>(null)
  const [deletingLandingId, setDeletingLandingId] = useState<string | null>(null)

  function load() {
    return supabase
      .from('lead_gen_links')
      .select('id, name, ref_token, funnel_id, entry_node_id, created_at, funnels ( name ), funnel_nodes ( config )')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setLinks((data ?? []) as unknown as LeadGenLinkRow[])
        setLoading(false)
      })
  }

  function loadLandings() {
    return supabase
      .from('landing_pages')
      .select('id, org_id, name, template_key, slug, status, config, funnel_id, entry_node_id, funnels ( name )')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setLandings((data ?? []) as unknown as LandingRow[])
        setLandingsLoading(false)
      })
  }

  useEffect(() => {
    load()
    loadLandings()
  }, [])

  async function handleDuplicate(link: LeadGenLinkRow) {
    setDuplicatingId(link.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDuplicatingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-leadgen-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: `${link.name} (копія)`, funnelId: link.funnel_id, entryNodeId: link.entry_node_id ?? undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося дублювати посилання')
      } else {
        await load()
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDuplicatingId(null)
    }
  }

  async function handleDelete(link: LeadGenLinkRow) {
    if (!window.confirm(`Видалити посилання «${link.name}»? Статистику кліків також буде втрачено.`)) return
    setDeletingId(link.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDeletingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-leadgen-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id: link.id, delete: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося видалити посилання')
      } else {
        setLinks((prev) => prev.filter((l) => l.id !== link.id))
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleDuplicateLanding(lp: LandingRow) {
    setDuplicatingLandingId(lp.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDuplicatingLandingId(null)
      return
    }

    // Slugs are unique per org, so the original's can't be reused as-is —
    // "-copy", then "-copy-2" etc. on a 409 collision. Truncated first so a
    // near-60-char slug plus suffix still satisfies SLUG_RE's 60-char cap.
    const base = lp.slug.slice(0, 53)
    let created = false
    let lastError = 'Не вдалося дублювати лендінг'

    for (let attempt = 1; attempt <= 5 && !created; attempt++) {
      const slug = attempt === 1 ? `${base}-copy` : `${base}-copy-${attempt}`
      try {
        const res = await fetch('/.netlify/functions/save-landing-page', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            name: `${lp.name} (копія)`,
            templateKey: lp.template_key,
            slug,
            // Never auto-published: a duplicate is a starting point to tweak,
            // not a second live page the moment it's created.
            status: 'draft',
            config: lp.config ?? {},
            // The copy routes to the same tunnel until it is changed in its editor.
            ...(lp.funnel_id && lp.entry_node_id ? { funnelId: lp.funnel_id, entryNodeId: lp.entry_node_id } : {}),
          }),
        })
        const data = await res.json()
        if (res.ok) {
          created = true
        } else if (res.status === 409) {
          lastError = data.error ?? lastError
          continue
        } else {
          lastError = data.error ?? lastError
          break
        }
      } catch {
        lastError = 'Мережева помилка. Спробуйте ще раз'
        break
      }
    }

    if (created) {
      await loadLandings()
    } else {
      setError(lastError)
    }
    setDuplicatingLandingId(null)
  }

  async function handleDeleteLanding(lp: LandingRow) {
    if (!window.confirm(`Видалити лендінг «${lp.name}»? Сторінка стане недоступною за своєю адресою.`)) return
    setDeletingLandingId(lp.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDeletingLandingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-landing-page', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id: lp.id, delete: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося видалити лендінг')
      } else {
        setLandings((prev) => prev.filter((l) => l.id !== lp.id))
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingLandingId(null)
    }
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Інструменти лідогенерації</h1>
          <p className="page-description">Посилання для реклами — кожен клік логується і веде у потрібний тунель</p>
        </div>
        {tab === 'links' ? (
          <button type="button" className="btn btn-primary" onClick={() => navigate('/dashboard/leadgentools/new')}>
            <IconPlus size={16} />
            Додати лінк
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => navigate('/dashboard/leadgentools/landings/new')}>
            <IconPlus size={16} />
            Додати лендінг
          </button>
        )}
      </div>

      <div className="tabs" style={{ marginBottom: '1rem' }}>
        <button type="button" className={`tab-trigger${tab === 'links' ? ' active' : ''}`} onClick={() => setSearchParams({})}>
          Посилання
        </button>
        <button type="button" className={`tab-trigger${tab === 'landings' ? ' active' : ''}`} onClick={() => setSearchParams({ tab: 'landings' })}>
          Лендінги
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {tab === 'landings' ? (
        landingsLoading ? (
          <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
        ) : landings.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state-icon">
              <IconLink size={22} />
            </span>
            <h3>Ще немає лендінгів</h3>
            <p>Проміжна сторінка прогріває ліда між кліком по рекламі та чатом. Три готові шаблони, без конструктора.</p>
          </div>
        ) : (
          <div className="lp-grid">
            {landings.map((lp) => {
              const cfg: LandingConfig = withConfigDefaults(lp.config)
              const publicUrl = `${window.location.origin}/lp/${lp.slug}`
              return (
                <div className="lp-card" key={lp.id}>
                  <button
                    type="button"
                    className="lp-card-thumb"
                    onClick={() => navigate(`/dashboard/leadgentools/landings/${lp.id}`)}
                    aria-label={`Редагувати ${lp.name}`}
                  >
                    <Thumb>
                      <LandingTemplate templateKey={lp.template_key} config={cfg} ctaHref={() => '#'} static />
                    </Thumb>
                    <span className="lp-card-hover">
                      <IconEdit size={14} />
                      Редагувати
                    </span>
                  </button>
                  <div className="lp-card-meta">
                    <div className="lp-card-row">
                      <span className="lp-card-name">{lp.name}</span>
                      <span className={`badge ${lp.status === 'published' ? 'badge-success' : 'badge-neutral'}`}>
                        {lp.status === 'published' ? 'Опубліковано' : 'Чернетка'}
                      </span>
                    </div>
                    <a className="lp-card-link" href={publicUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      <IconLink size={12} />
                      /lp/{lp.slug}
                    </a>
                    <div className="lp-card-row sub">
                      <span>{TEMPLATE_META[lp.template_key]?.label ?? lp.template_key}</span>
                      <span>{lp.funnels?.name ? `Тунель: ${lp.funnels.name}` : 'тунель не обрано'}</span>
                    </div>
                    <div className="lp-card-row" style={{ justifyContent: 'flex-end', gap: '0.25rem' }}>
                      <button
                        type="button"
                        className="btn-icon-ghost"
                        onClick={() => navigate(`/dashboard/leadgentools/landings/${lp.id}`)}
                        aria-label="Редагувати лендінг"
                        title="Редагувати"
                      >
                        <IconEdit size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon-ghost"
                        disabled={duplicatingLandingId === lp.id}
                        onClick={() => handleDuplicateLanding(lp)}
                        aria-label="Дублювати лендінг"
                        title="Дублювати"
                      >
                        {duplicatingLandingId === lp.id ? <IconSpinner size={14} /> : <IconDuplicate size={14} />}
                      </button>
                      <button
                        type="button"
                        className="btn-icon-ghost"
                        disabled={deletingLandingId === lp.id}
                        onClick={() => handleDeleteLanding(lp)}
                        aria-label="Видалити лендінг"
                        title="Видалити"
                      >
                        {deletingLandingId === lp.id ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : links.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">
            <IconLink size={22} />
          </span>
          <h3>Ще немає посилань</h3>
          <p>Створіть перше посилання, щоб почати приводити лідів у тунель.</p>
        </div>
      ) : (
        <div className="funnel-list">
          {links.map((link) => (
            <div
              className="card funnel-row"
              key={link.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/dashboard/leadgentools/${link.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') navigate(`/dashboard/leadgentools/${link.id}`)
              }}
              style={{ cursor: 'pointer' }}
            >
              <div className="funnel-row-info">
                <span className="funnel-row-name">{link.name}</span>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.125rem' }}>
                  <span className="badge badge-neutral">{link.funnels?.name ?? 'Тунель'}</span>
                  {link.funnel_nodes?.config?.label && (
                    <span className="badge badge-success">{link.funnel_nodes.config.label}</span>
                  )}
                </div>
              </div>
              <div className="funnel-row-actions" onClick={(e) => e.stopPropagation()} style={{ gap: '1rem' }}>
                <ChannelCopyButtons refToken={link.ref_token} />
                <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  <button
                    type="button"
                    className="btn-icon-ghost"
                    onClick={() => navigate(`/dashboard/leadgentools/${link.id}`)}
                    aria-label="Редагувати посилання"
                    title="Редагувати"
                  >
                    <IconEdit size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon-ghost"
                    disabled={duplicatingId === link.id}
                    onClick={() => handleDuplicate(link)}
                    aria-label="Дублювати посилання"
                    title="Дублювати"
                  >
                    {duplicatingId === link.id ? <IconSpinner size={14} /> : <IconDuplicate size={14} />}
                  </button>
                  <button
                    type="button"
                    className="btn-icon-ghost"
                    disabled={deletingId === link.id}
                    onClick={() => handleDelete(link)}
                    aria-label="Видалити посилання"
                    title="Видалити"
                  >
                    {deletingId === link.id ? <IconSpinner size={14} /> : <IconTrash size={14} />}
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
