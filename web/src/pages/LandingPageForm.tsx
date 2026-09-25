import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  ACCENT_SWATCHES,
  COUNTDOWN_MODES,
  EMPTY_CONFIG,
  LANDING_TEMPLATES,
  LANDING_THEMES,
  LandingTemplate,
  TEMPLATE_META,
  THEME_META,
  withConfigDefaults,
  type CountdownMode,
  type ImageUploadState,
  type LandingConfig,
  type LandingTemplateKey,
} from '../components/LandingTemplates'
import { RESERVED_SLUGS } from '../lib/reservedSlugs'
import { IconAlert, IconArrowLeft, IconCheckCircle, IconLink, IconPlus, IconSpinner, IconTrash } from '../components/icons'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$/
const PIXEL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '',
}
function slugify(input: string) {
  return input.toLowerCase().split('').map((c) => CYR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

interface ExistingPage {
  id: string
  org_id: string
  name: string
  template_key: LandingTemplateKey
  slug: string
  status: 'draft' | 'published'
  config: Partial<LandingConfig> | null
  meta_access_token_secret_id: string | null
}

const COUNTDOWN_LABEL: Record<CountdownMode, string> = { off: 'Вимкнено', deadline: 'До дати', cycle: 'Циклічний' }

// <input type="datetime-local"> speaks local wall-clock time without a zone;
// the config stores an ISO instant.
function toLocalInput(iso: string) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// One collapsible section per topic. <details> keeps it keyboard- and
// screen-reader-friendly without any open/closed state to manage; the dot
// shows a section holds values while it is collapsed.
function Acc({ title, filled, children }: { title: string; filled?: boolean; children: React.ReactNode }) {
  return (
    <details className="lpe-acc">
      <summary>
        {filled && <span className="dot" aria-label="заповнено" />}
        {title}
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="lpe-acc-body">{children}</div>
    </details>
  )
}

export default function LandingPageForm() {
  const navigate = useNavigate()
  const { pageId } = useParams<{ pageId: string }>()
  const isEditing = !!pageId

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  // The slug this page already owns — never reported as "taken" to itself.
  const [ownSlug, setOwnSlug] = useState('')
  const [slugState, setSlugState] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle')
  const [templateKey, setTemplateKey] = useState<LandingTemplateKey>('minimal')
  const [status, setStatus] = useState<'draft' | 'published'>('draft')
  const [config, setConfig] = useState<LandingConfig>(EMPTY_CONFIG)
  const [tab, setTab] = useState<'main' | 'tech'>('main')
  const [capiToken, setCapiToken] = useState('')
  const [hasCapiToken, setHasCapiToken] = useState(false)
  const [upload, setUpload] = useState<ImageUploadState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      if (pageId) {
        const { data } = await supabase
          .from('landing_pages')
          .select('id, org_id, name, template_key, slug, status, config, meta_access_token_secret_id')
          .eq('id', pageId)
          .maybeSingle()
        if (cancelled) return
        const p = data as ExistingPage | null
        if (!p) setNotFound(true)
        else {
          setName(p.name)
          setSlug(p.slug)
          setOwnSlug(p.slug)
          setSlugTouched(true)
          setTemplateKey(p.template_key)
          setStatus(p.status)
          setHasCapiToken(!!p.meta_access_token_secret_id)
          setConfig(withConfigDefaults(p.config))
        }
      }
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [pageId])

  // Live availability while typing. Slugs are global and RLS hides other orgs'
  // rows, so this asks check-landing-slug (yes/no only). Debounced; a late
  // answer for a slug that's no longer in the field is dropped. The page's own
  // current slug and anything invalid/reserved never go over the wire.
  useEffect(() => {
    if (!slug || !SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug) || slug === ownSlug) {
      setSlugState('idle')
      return
    }
    setSlugState('checking')
    const ctrl = new AbortController()
    const t = window.setTimeout(() => {
      fetch(`/.netlify/functions/check-landing-slug?slug=${encodeURIComponent(slug)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { available: boolean }) => setSlugState(d.available ? 'available' : 'taken'))
        .catch((e) => {
          if (e?.name !== 'AbortError') setSlugState('error')
        })
    }, 350)
    return () => {
      window.clearTimeout(t)
      ctrl.abort()
    }
  }, [slug, ownSlug])

  function patch(part: Partial<LandingConfig>) {
    setConfig((c) => ({ ...c, ...part }))
    setDirty(true)
    setSaved(false)
  }

  async function onImageFile(file: File) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setUpload({ kind: 'error', message: `Це не зображення — ${file.name}` })
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUpload({ kind: 'error', message: `Файл завеликий — ${(file.size / 1048576).toFixed(1)} MB. Максимум 4 MB.` })
      return
    }
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setUpload({ kind: 'error', message: 'Сесія недійсна, увійдіть знову' })
      return
    }
    setUpload({ kind: 'uploading', progress: 0, name: file.name, size: file.size })
    const dataBase64 = await blobToBase64(file)
    // XHR instead of fetch purely for upload progress events.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/.netlify/functions/upload-attachment')
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.setRequestHeader('authorization', `Bearer ${accessToken}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUpload({ kind: 'uploading', progress: (e.loaded / e.total) * 100, name: file.name, size: file.size })
    }
    xhr.onerror = () => setUpload({ kind: 'error', message: 'Мережева помилка. Спробуйте ще раз' })
    xhr.onload = () => {
      let data: { url?: string; error?: string } = {}
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.url) {
        patch({ image_url: data.url })
        setUpload({ kind: 'idle' })
      } else {
        setUpload({ kind: 'error', message: data.error ?? 'Не вдалося завантажити файл' })
      }
    }
    xhr.send(JSON.stringify({ filename: file.name, contentType: file.type, dataBase64 }))
  }

  async function submit(nextStatus: 'draft' | 'published', opts?: { clearToken?: boolean }) {
    setSaving(true)
    setError(null)
    setSaved(false)
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSaving(false)
      return
    }
    try {
      const res = await fetch('/.netlify/functions/save-landing-page', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          id: pageId,
          name: name.trim(),
          slug,
          templateKey,
          status: nextStatus,
          config,
          // undefined keeps the stored token, null clears it.
          metaAccessToken: opts?.clearToken ? null : capiToken.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Не вдалося зберегти лендінг')
      else {
        setStatus(data.landingPage.status)
        setConfig(withConfigDefaults(data.landingPage.config))
        setHasCapiToken(!!data.landingPage.hasMetaToken)
        setOwnSlug(data.landingPage.slug)
        setCapiToken('')
        setSaved(true)
        setDirty(false)
        if (!pageId) navigate(`/dashboard/leadgentools/landings/${data.landingPage.id}`, { replace: true })
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!pageId || !window.confirm(`Видалити лендінг «${name}»? Лінки, що його використовують, знову вестимуть одразу в месенджер.`)) return
    setDeleting(true)
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setDeleting(false)
      return
    }
    const res = await fetch('/.netlify/functions/save-landing-page', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ id: pageId, delete: true }),
    })
    if (res.ok) navigate('/dashboard/leadgentools?tab=landings')
    else setDeleting(false)
  }

  const slugValid = SLUG_RE.test(slug)
  const slugReserved = RESERVED_SLUGS.has(slug)
  const canSave = !!name.trim() && slugValid && !slugReserved && slugState !== 'taken' && !saving && upload.kind !== 'uploading'
  const hasCta = config.ctas.some((c) => c.enabled)
  // Hidden while the slug is someone else's — the link would open their page.
  const publicUrl = slugValid && !slugReserved && slugState !== 'taken' ? `${window.location.origin}/lp/${slug}` : ''

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/dashboard/leadgentools?tab=landings')} style={{ marginBottom: '0.75rem', paddingLeft: 0 }}>
            <IconArrowLeft size={15} />
            До списку
          </button>
          <h1 className="page-title">{isEditing ? 'Редагування лендінга' : 'Новий лендінг'}</h1>
          <p className="page-description">Клікніть на будь-який текст, картинку чи кнопку прямо на макеті — редагується на місці</p>
        </div>
        {isEditing && (
          <span className={`badge ${status === 'published' ? 'badge-success' : 'badge-neutral'}`}>{status === 'published' ? 'Опубліковано' : 'Чернетка'}</span>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : notFound ? (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>Лендінг не знайдено</span>
        </div>
      ) : (
        <div className="lpe-stage">
          <div className="lpe-phone-wrap">
            <div className={`lpe-phone-glow ${config.theme}`} />
            <div className="lpe-phone">
              <span className="btnL" /><span className="btnL2" /><span className="btnR" />
              <div className="lpe-screen">
                <div className="lpe-island" />
                <LandingTemplate templateKey={templateKey} config={config} ctaHref={() => '#'} edit={{ onChange: patch, onImageFile, upload }} />
              </div>
            </div>
          </div>

          <aside className="lpe-side">
            <div className="card lpe-panel">
              <div className="tabs lpe-tabs">
                <button type="button" className={`tab-trigger${tab === 'main' ? ' active' : ''}`} onClick={() => setTab('main')}>
                  Налаштування
                </button>
                <button type="button" className={`tab-trigger${tab === 'tech' ? ' active' : ''}`} onClick={() => setTab('tech')}>
                  Технічні
                </button>
              </div>

              {tab === 'main' ? (
                <div className="lpe-fields">
                  <div className="field">
                    <label htmlFor="lpe-name">Назва (внутрішня)</label>
                    <input
                      id="lpe-name"
                      className="input"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value)
                        if (!slugTouched) setSlug(slugify(e.target.value))
                        setDirty(true)
                      }}
                      placeholder="напр. Літня кампанія — Instagram"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="lpe-slug">Адреса</label>
                    <div className="input-wrap" style={{ alignItems: 'center' }}>
                      <span className="lpe-slug-pre">/lp/</span>
                      <input
                        id="lpe-slug"
                        className={`input${slug && (!slugValid || slugReserved || slugState === 'taken') ? ' is-invalid' : ''}`}
                        value={slug}
                        onChange={(e) => {
                          setSlugTouched(true)
                          setSlug(e.target.value.toLowerCase())
                          setDirty(true)
                        }}
                        placeholder="summer-ig"
                        style={{ paddingLeft: '0.25rem' }}
                      />
                    </div>
                    {slug && !slugValid && (
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0', color: 'var(--danger)' }}>
                        3–60 символів: латиниця в нижньому регістрі, цифри, дефіс
                      </p>
                    )}
                    {slugValid && slugReserved && (
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0', color: 'var(--danger)' }}>
                        Ця адреса зарезервована системою — оберіть іншу
                      </p>
                    )}
                    {slugValid && !slugReserved && slugState === 'taken' && (
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0', color: 'var(--danger)' }}>
                        Ця адреса вже зайнята — оберіть іншу
                      </p>
                    )}
                    {slugValid && !slugReserved && slugState === 'available' && slug !== ownSlug && (
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0', color: 'var(--success)' }}>
                        Адреса вільна
                      </p>
                    )}
                    {publicUrl && (
                      <a className="lpe-public-link" href={publicUrl} target="_blank" rel="noopener noreferrer">
                        <IconLink size={13} />
                        <span>/lp/{slug}</span>
                        {status !== 'published' && <i>чернетка — лінк запрацює після публікації</i>}
                      </a>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="lpe-tpl">Шаблон</label>
                    <select
                      id="lpe-tpl"
                      className="input"
                      value={templateKey}
                      onChange={(e) => {
                        setTemplateKey(e.target.value as LandingTemplateKey)
                        setDirty(true)
                      }}
                    >
                      {LANDING_TEMPLATES.map((k) => (
                        <option key={k} value={k}>
                          {TEMPLATE_META[k].label}
                        </option>
                      ))}
                    </select>
                    <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>{TEMPLATE_META[templateKey].hint}</p>
                  </div>
                  <div className="field">
                    <label>Тема</label>
                    <div className="lpe-seg">
                      {LANDING_THEMES.map((t) => (
                        <button key={t} type="button" className={config.theme === t ? 'on' : ''} onClick={() => patch({ theme: t })}>
                          <i className={`lpe-sw ${t}`} />
                          {THEME_META[t]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {templateKey === 'product' && (
                    <div className="field">
                      <label htmlFor="lpe-cd">Лічильник</label>
                      <select id="lpe-cd" className="input" value={config.countdown_mode} onChange={(e) => patch({ countdown_mode: e.target.value as CountdownMode })}>
                        {COUNTDOWN_MODES.map((m) => (
                          <option key={m} value={m}>
                            {COUNTDOWN_LABEL[m]}
                          </option>
                        ))}
                      </select>
                      {config.countdown_mode === 'deadline' && (
                        <input
                          type="datetime-local"
                          className="input"
                          style={{ marginTop: '0.5rem' }}
                          value={toLocalInput(config.countdown_deadline_at)}
                          onChange={(e) => patch({ countdown_deadline_at: e.target.value ? new Date(e.target.value).toISOString() : '' })}
                          aria-label="Дата і час завершення"
                        />
                      )}
                      {config.countdown_mode === 'cycle' && (
                        <div className="input-wrap" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
                          <input
                            type="number"
                            className="input"
                            min={1}
                            max={168}
                            value={config.countdown_cycle_hours}
                            onChange={(e) => patch({ countdown_cycle_hours: Math.min(168, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                            aria-label="Тривалість циклу в годинах"
                          />
                          <span className="lpe-slug-pre" style={{ paddingRight: '0.75rem' }}>год, потім знову</span>
                        </div>
                      )}
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                        {config.countdown_mode === 'deadline'
                          ? 'Після цієї дати лічильник зникає зі сторінки. Час — ваш місцевий.'
                          : config.countdown_mode === 'cycle'
                            ? 'Щоразу відраховує заново; цикл 24 год скидається опівночі за часом відвідувача.'
                            : 'Показується під ціною. Підпис редагується прямо на макеті.'}
                      </p>
                    </div>
                  )}
                  <div className="field">
                    <label>Акцент</label>
                    <div className="lpe-swatches">
                      {ACCENT_SWATCHES.map((c) => (
                        <button key={c} type="button" className={config.accent_color === c ? 'on' : ''} style={{ background: c }} onClick={() => patch({ accent_color: c })} aria-label={c} />
                      ))}
                      <input type="color" value={config.accent_color} onChange={(e) => patch({ accent_color: e.target.value })} aria-label="Свій колір" />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="lpe-fields">
                  <Acc title="SEO" filled={!!(config.seo_title || config.seo_description)}>
                    <div className="field">
                      <label htmlFor="lpe-seo-t">Title сторінки</label>
                      <input id="lpe-seo-t" className="input" value={config.seo_title} onChange={(e) => patch({ seo_title: e.target.value })} placeholder="Порожньо — візьметься заголовок" maxLength={120} />
                    </div>
                    <div className="field">
                      <label htmlFor="lpe-seo-d">Meta description</label>
                      <textarea id="lpe-seo-d" className="input textarea" rows={2} value={config.seo_description} onChange={(e) => patch({ seo_description: e.target.value })} maxLength={300} />
                    </div>
                  </Acc>

                  <Acc title="Facebook Pixel + CAPI" filled={!!config.fb_pixel_id || hasCapiToken}>
                    <div className="field">
                      <label htmlFor="lpe-fb">Pixel ID</label>
                      <input
                        id="lpe-fb"
                        className={`input${config.fb_pixel_id && !PIXEL_ID_RE.test(config.fb_pixel_id) ? ' is-invalid' : ''}`}
                        value={config.fb_pixel_id}
                        onChange={(e) => patch({ fb_pixel_id: e.target.value.trim() })}
                        placeholder="1234567890123456"
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                      />
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                        Піксель самого лендінга: PageView при відкритті й Lead при кліку на кнопку. Працює незалежно від того,
                        чи прикріплений лендінг до лінка лідогенерації, і не змішується з його конверсіями.
                      </p>
                    </div>
                    <div className="field">
                      <label htmlFor="lpe-capi">Токен CAPI (опційно)</label>
                      <input
                        id="lpe-capi"
                        className="input input-masked"
                        type="text"
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        value={capiToken}
                        onChange={(e) => { setCapiToken(e.target.value); setDirty(true) }}
                        placeholder={hasCapiToken ? 'Збережено — введіть новий, щоб замінити' : 'EAAG…'}
                      />
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                        Дублює PageView і Lead server-side (з fbclid, _fbp, _fbc), щоб події рахувалися навіть із блокувальником.
                        Зберігається зашифровано й не показується повторно.
                        {hasCapiToken && (
                          <>
                            {' '}
                            <button type="button" className="lpe-link-btn" onClick={() => submit(status, { clearToken: true })} disabled={!canSave}>
                              Видалити токен
                            </button>
                          </>
                        )}
                      </p>
                    </div>
                  </Acc>

                  <Acc title="TikTok" filled={!!config.tiktok_pixel_id}>
                    <div className="field">
                      <label htmlFor="lpe-tt">TikTok Pixel ID</label>
                      <input
                        id="lpe-tt"
                        className={`input${config.tiktok_pixel_id && !PIXEL_ID_RE.test(config.tiktok_pixel_id) ? ' is-invalid' : ''}`}
                        value={config.tiktok_pixel_id}
                        onChange={(e) => patch({ tiktok_pixel_id: e.target.value.trim() })}
                        placeholder="CXXXXXXXXXXXXXXXXXXX"
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                      />
                    </div>
                  </Acc>

                  <Acc title="Google" filled={!!config.google_tag_id}>
                    <div className="field">
                      <label htmlFor="lpe-ga">Google tag ID</label>
                      <input
                        id="lpe-ga"
                        className={`input${config.google_tag_id && !PIXEL_ID_RE.test(config.google_tag_id) ? ' is-invalid' : ''}`}
                        value={config.google_tag_id}
                        onChange={(e) => patch({ google_tag_id: e.target.value.trim() })}
                        placeholder="G-XXXXXXX або AW-XXXXXXX"
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                      />
                    </div>
                  </Acc>

                  <Acc title="Privacy" filled={!!config.privacy_url}>
                    <div className="field">
                      <label htmlFor="lpe-priv">Посилання на політику конфіденційності</label>
                      <input id="lpe-priv" className="input" value={config.privacy_url} onChange={(e) => patch({ privacy_url: e.target.value.trim() })} placeholder="https://…" />
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>Текст лінка редагується прямо у футері макета.</p>
                    </div>
                  </Acc>

                  <Acc title="Кастомний код" filled={!!(config.head_code || config.body_code)}>
                    <div className="field">
                      <label htmlFor="lpe-head">Код у &lt;head&gt;</label>
                      <textarea id="lpe-head" className="input textarea lpe-code" rows={4} value={config.head_code} onChange={(e) => patch({ head_code: e.target.value })} maxLength={8000} spellCheck={false} placeholder="<meta …> / <script>…</script>" />
                    </div>
                    <div className="field">
                      <label htmlFor="lpe-body">Код у &lt;body&gt;</label>
                      <textarea id="lpe-body" className="input textarea lpe-code" rows={4} value={config.body_code} onChange={(e) => patch({ body_code: e.target.value })} maxLength={8000} spellCheck={false} />
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                        Виконується в ізольованому фреймі (sandbox), без доступу до сторінки, cookies і сесії. Зовнішні
                        скрипти дозволені лише з доменів Meta, TikTok і Google — для них краще використовувати поля вище.
                      </p>
                    </div>
                  </Acc>
                </div>
              )}

              <div className="lpe-actions">
                <button type="button" className="btn btn-secondary" disabled={!canSave} onClick={() => submit(status)}>
                  {saving ? <IconSpinner size={16} /> : <IconCheckCircle size={16} />}
                  {status === 'published' ? 'Зберегти' : 'Зберегти чернетку'}
                </button>
                {status === 'published' ? (
                  <button type="button" className="btn btn-ghost" disabled={!canSave} onClick={() => submit('draft')}>
                    Зняти з публікації
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" disabled={!canSave || !config.headline.trim() || !hasCta} onClick={() => submit('published')} title={!hasCta ? 'Увімкніть хоча б одну кнопку' : undefined}>
                    <IconPlus size={16} />
                    Опублікувати
                  </button>
                )}
                {isEditing && (
                  <button type="button" className="btn-icon-ghost" onClick={handleDelete} disabled={deleting} aria-label="Видалити лендінг" title="Видалити" style={{ marginLeft: 'auto' }}>
                    {deleting ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                  </button>
                )}
              </div>

              {error && (
                <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>
                  <IconAlert size={16} />
                  <span>{error}</span>
                </div>
              )}
              {saved && !error && (
                <div className="alert" style={{ marginTop: '0.75rem', background: 'var(--success-soft)', color: 'var(--success)', borderColor: 'transparent' }}>
                  <IconCheckCircle size={16} />
                  <span>Збережено</span>
                </div>
              )}
              {dirty && !saved && <p className="lpe-dirty">Є незбережені зміни</p>}
            </div>

            <div className="card lpe-hints">
              <h3>Як редагувати</h3>
              <ul>
                <li><b>Текст</b> — клікабельний весь: заголовок, підписи, плашки, футер. Enter завершує, Esc скасовує.</li>
                <li><b>Колір</b> — наведіть на заголовок чи підзаголовок, над ним з’являться кольорові крапки. Перша — типовий колір теми.</li>
                <li><b>Картинка</b> — перетягніть файл на зону або клікніть на неї. PNG/JPG/WebP до 4 MB. Перемикач 1:1 / 2:3 у кутку.</li>
                <li><b>Кнопки</b> — показані всі три месенджери; перемикач вмикає кнопку, крапки над нею змінюють колір, другий рядок теж редагується.</li>
                {(templateKey === 'problem_solution' || templateKey === 'social_proof' || templateKey === 'product') && (
                  <li><b>Тригер терміновості</b> — рядок над кнопками, перемикач «Тригер» показує або ховає.</li>
                )}
                {templateKey === 'problem_solution' && <li><b>Переваги</b> — картки під картинкою, додаються кнопкою «+ Додати перевагу».</li>}
                {templateKey === 'hr_vacancy' && <li><b>Зарплата</b> — акцентний чіп під мета-рядком; клікніть на нього, щоб змінити.</li>}
                {templateKey === 'product' && <li><b>Ціна</b> — акцентний рядок під заголовком, редагується кліком.</li>}
                <li><b>Кулька</b> справа — відкриває меню з усіма увімкненими кнопками, щоб людина обрала, де їй зручніше.</li>
              </ul>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
