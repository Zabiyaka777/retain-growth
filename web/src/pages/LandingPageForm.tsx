import { useEffect, useRef, useState, type RefObject } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  ACCENT_SWATCHES,
  COUNTDOWN_MODES,
  EMPTY_CONFIG,
  LANDING_TEMPLATES,
  LANDING_THEMES,
  LandingTemplate,
  MAX_PRODUCT_IMAGES,
  ORB_ANIMATIONS,
  ORB_SIZES,
  TEMPLATE_META,
  THEME_META,
  withConfigDefaults,
  type CountdownMode,
  type ImageUploadState,
  type LandingConfig,
  type LandingTemplateKey,
  type OrbAnimation,
  type OrbSize,
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
  funnel_id: string | null
  entry_node_id: string | null
}

interface FunnelOption {
  id: string
  name: string
}

interface EntryNodeOption {
  id: string
  label: string
}

const ORB_SIZE_LABEL: Record<OrbSize, string> = { sm: 'S', md: 'M', lg: 'L' }
const ORB_ANIMATION_LABEL: Record<OrbAnimation, string> = { none: 'Без анімації', pulse: 'Пульс', bounce: 'Підстрибування' }

// A slim scroll indicator that sits BESIDE the phone frame (never inside the
// screen, where it would cover the page): shows where the viewport is in the
// page and can be dragged, or clicked, to jump — editing a long page through
// a narrow phone-sized window is otherwise a lot of wheel scrolling.
function PhoneScrollbar({ screenRef }: { screenRef: RefObject<HTMLDivElement | null> }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null)
  const [thumb, setThumb] = useState({ top: 0, height: 100, visible: false })

  useEffect(() => {
    const scroller = screenRef.current?.querySelector<HTMLElement>('.lp-scroll') ?? null
    scrollerRef.current = scroller
    if (!scroller) return
    const read = () => {
      const { scrollTop, scrollHeight, clientHeight } = scroller
      const height = Math.max((clientHeight / Math.max(scrollHeight, 1)) * 100, 8)
      const range = scrollHeight - clientHeight
      setThumb({ visible: range > 1, height, top: range > 1 ? (scrollTop / range) * (100 - height) : 0 })
    }
    read()
    scroller.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(scroller)
    if (scroller.firstElementChild) ro.observe(scroller.firstElementChild)
    return () => {
      scroller.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [screenRef])

  function jumpTo(fraction: number) {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTop = Math.min(1, Math.max(0, fraction)) * (scroller.scrollHeight - scroller.clientHeight)
  }

  function onTrackDown(e: React.PointerEvent<HTMLDivElement>) {
    const track = trackRef.current
    if (!track || e.target !== track) return
    const rect = track.getBoundingClientRect()
    const travel = 1 - thumb.height / 100
    // Centre the thumb where the track was clicked.
    jumpTo(travel > 0 ? ((e.clientY - rect.top) / rect.height - thumb.height / 200) / travel : 0)
  }

  function onThumbDown(e: React.PointerEvent<HTMLDivElement>) {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* not capturable — moves still reach the thumb while the pointer is over it */
    }
    dragRef.current = { startY: e.clientY, startTop: scrollerRef.current?.scrollTop ?? 0 }
  }
  function onThumbMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    const scroller = scrollerRef.current
    const track = trackRef.current
    if (!drag || !scroller || !track) return
    const travelPx = track.clientHeight * (1 - thumb.height / 100)
    if (travelPx <= 0) return
    scroller.scrollTop = drag.startTop + ((e.clientY - drag.startY) / travelPx) * (scroller.scrollHeight - scroller.clientHeight)
  }
  function onThumbUp(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  if (!thumb.visible) return null
  return (
    <div ref={trackRef} className="lpe-scrollbar" onPointerDown={onTrackDown} aria-hidden="true">
      <div
        className="lpe-scrollbar-thumb"
        style={{ top: `${thumb.top}%`, height: `${thumb.height}%` }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
      />
    </div>
  )
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
  const [, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const screenRef = useRef<HTMLDivElement>(null)
  // Where the page's messenger buttons lead — the page's own tunnel, independent of any lead-gen link.
  const [funnels, setFunnels] = useState<FunnelOption[]>([])
  const [funnelId, setFunnelId] = useState('')
  const [entryNodes, setEntryNodes] = useState<EntryNodeOption[]>([])
  const [entryNodesLoading, setEntryNodesLoading] = useState(false)
  const [entryNodeId, setEntryNodeId] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const { data: funnelsData } = await supabase.from('funnels').select('id, name').order('name')
      if (cancelled) return
      setFunnels((funnelsData ?? []) as FunnelOption[])
      if (pageId) {
        const { data } = await supabase
          .from('landing_pages')
          .select('id, org_id, name, template_key, slug, status, config, meta_access_token_secret_id, funnel_id, entry_node_id')
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
          setFunnelId(p.funnel_id ?? '')
          setEntryNodeId(p.entry_node_id ?? '')
        }
      }
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [pageId])

  // Entry points of the picked funnel; picking a different funnel clears the
  // entry choice in its own handler, so a just-loaded value is never wiped.
  useEffect(() => {
    if (!funnelId) {
      setEntryNodes([])
      return
    }
    let cancelled = false
    setEntryNodesLoading(true)
    supabase
      .from('funnel_nodes')
      .select('id, config')
      .eq('funnel_id', funnelId)
      .eq('type', 'entry')
      .then(({ data }) => {
        if (cancelled) return
        const options = ((data ?? []) as { id: string; config: { label?: string } | null }[]).map((n) => ({
          id: n.id,
          label: n.config?.label?.trim() || 'Точка входу без назви',
        }))
        setEntryNodes(options)
        setEntryNodesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [funnelId])

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

  // Uploads one image; resolves to its URL, or null after showing the reason.
  async function uploadImageFile(file: File): Promise<string | null> {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setUpload({ kind: 'error', message: `Це не зображення — ${file.name}` })
      return null
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUpload({ kind: 'error', message: `Файл завеликий — ${(file.size / 1048576).toFixed(1)} MB. Максимум 4 MB.` })
      return null
    }
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setUpload({ kind: 'error', message: 'Сесія недійсна, увійдіть знову' })
      return null
    }
    setUpload({ kind: 'uploading', progress: 0, name: file.name, size: file.size })
    const dataBase64 = await blobToBase64(file)
    // XHR instead of fetch purely for upload progress events.
    return new Promise<string | null>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/.netlify/functions/upload-attachment')
      xhr.setRequestHeader('content-type', 'application/json')
      xhr.setRequestHeader('authorization', `Bearer ${accessToken}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUpload({ kind: 'uploading', progress: (e.loaded / e.total) * 100, name: file.name, size: file.size })
      }
      xhr.onerror = () => {
        setUpload({ kind: 'error', message: 'Мережева помилка. Спробуйте ще раз' })
        resolve(null)
      }
      xhr.onload = () => {
        let data: { url?: string; error?: string } = {}
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          /* non-JSON body */
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.url) {
          setUpload({ kind: 'idle' })
          resolve(data.url)
        } else {
          setUpload({ kind: 'error', message: data.error ?? 'Не вдалося завантажити файл' })
          resolve(null)
        }
      }
      xhr.send(JSON.stringify({ filename: file.name, contentType: file.type, dataBase64 }))
    })
  }

  async function onImageFile(file: File) {
    const url = await uploadImageFile(file)
    if (url) patch({ image_url: url })
  }

  // Product carousel: files go up one after another (a single progress bar),
  // each appended to the gallery as soon as it lands. The first slide is kept
  // mirrored in image_url so the single-image fallback and old readers agree.
  async function onGalleryFiles(files: File[]) {
    for (const file of files) {
      const url = await uploadImageFile(file)
      if (!url) return
      setConfig((c) => {
        const current = c.product_images.length ? c.product_images : c.image_url ? [c.image_url] : []
        const next = [...current, url].slice(0, MAX_PRODUCT_IMAGES)
        return { ...c, product_images: next, image_url: next[0] ?? '' }
      })
      setDirty(true)
      setSaved(false)
    }
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
          // Only when the page has messenger buttons AND a full choice.
          ...(needsFunnel && funnelId && entryNodeId ? { funnelId, entryNodeId } : {}),
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
    if (!pageId || !window.confirm(`Видалити лендінг «${name}»? Сторінка стане недоступною за своєю адресою.`)) return
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
  const hasCta = config.ctas.some((c) => c.enabled)
  // Messenger buttons exist only when at least one enabled CTA goes through the
  // funnel (a plain «Лінк» button needs no tunnel).
  const needsFunnel = config.ctas.some((c) => c.enabled && c.type === 'funnel')
  const routingHalf = !!funnelId !== !!entryNodeId
  const routingMissing = needsFunnel && (!funnelId || !entryNodeId)
  const canSave = !!name.trim() && slugValid && !slugReserved && slugState !== 'taken' && !saving && upload.kind !== 'uploading' && !routingHalf
  const canPublish = canSave && !!config.headline.trim() && hasCta && !routingMissing
  // Hidden while the slug is someone else's — the link would open their page.
  const publicUrl = slugValid && !slugReserved && slugState !== 'taken' ? `${window.location.origin}/lp/${slug}` : ''

  return (
    <div className="page fade-in">
      <div className="lpe-stickybar">
        <button type="button" className="btn btn-ghost" onClick={() => navigate('/dashboard/leadgentools?tab=landings')} style={{ paddingLeft: 0 }}>
          <IconArrowLeft size={15} />
          До списку
        </button>
        {!loading && !notFound && (
          <div className="lpe-topbar">
            <div className="lpe-topbar-row">
              {status === 'published' && (
                <button type="button" className="lpe-btn lpe-btn-unpublish" disabled={!canSave} onClick={() => submit('draft')}>
                  Зняти з публікації
                </button>
              )}
              {status === 'published' ? (
                dirty ? (
                  <button type="button" className="lpe-btn lpe-btn-warn" disabled={!canPublish} onClick={() => submit('published')} title={routingMissing ? 'Оберіть тунель і точку входу' : undefined}>
                    {saving ? <IconSpinner size={16} /> : <IconCheckCircle size={16} />}
                    Зберегти
                  </button>
                ) : (
                  <button type="button" className="lpe-btn lpe-btn-ok" disabled aria-live="polite">
                    {saving ? <IconSpinner size={16} /> : <IconCheckCircle size={16} />}
                    Опубліковано
                  </button>
                )
              ) : (
                <>
                  <button type="button" className={`lpe-btn ${dirty ? 'lpe-btn-warn' : 'lpe-btn-neutral'}`} disabled={!canSave} onClick={() => submit('draft')}>
                    {saving ? <IconSpinner size={16} /> : <IconCheckCircle size={16} />}
                    {dirty || !isEditing ? 'Зберегти чернетку' : 'Чернетку збережено'}
                  </button>
                  <button
                    type="button"
                    className="lpe-btn lpe-btn-primary"
                    disabled={!canPublish}
                    onClick={() => submit('published')}
                    title={!hasCta ? 'Увімкніть хоча б одну кнопку' : routingMissing ? 'Оберіть тунель і точку входу' : undefined}
                  >
                    <IconPlus size={16} />
                    Опублікувати
                  </button>
                </>
              )}
            </div>
            {dirty && <p className="lpe-dirty">Є незбережені зміни</p>}
          </div>
        )}
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">{isEditing ? 'Редагування лендінга' : 'Новий лендінг'}</h1>
          <p className="page-description">Клікніть на будь-який текст, картинку чи кнопку прямо на макеті — редагується на місці</p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

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
              <div className="lpe-screen" ref={screenRef}>
                <div className="lpe-island" />
                <LandingTemplate templateKey={templateKey} config={config} ctaHref={() => '#'} edit={{ onChange: patch, onImageFile, onGalleryFiles, upload }} />
              </div>
            </div>
            <PhoneScrollbar screenRef={screenRef} />
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
                  {needsFunnel && (
                    <div className="field lpe-routing">
                      <label htmlFor="lpe-funnel">Куди ведуть кнопки месенджерів</label>
                      <select
                        id="lpe-funnel"
                        className="input"
                        value={funnelId}
                        onChange={(e) => {
                          setFunnelId(e.target.value)
                          // The old entry point belonged to a different funnel.
                          setEntryNodeId('')
                          setDirty(true)
                          setSaved(false)
                        }}
                      >
                        <option value="">Оберіть тунель</option>
                        {funnels.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                      <select
                        id="lpe-entry-node"
                        className="input"
                        style={{ marginTop: '0.5rem' }}
                        value={entryNodeId}
                        disabled={!funnelId || entryNodesLoading}
                        onChange={(e) => {
                          setEntryNodeId(e.target.value)
                          setDirty(true)
                          setSaved(false)
                        }}
                        aria-label="Точка входу"
                      >
                        <option value="">{!funnelId ? 'Спершу оберіть тунель' : entryNodesLoading ? 'Завантаження…' : 'Оберіть точку входу'}</option>
                        {entryNodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.label}
                          </option>
                        ))}
                      </select>
                      {funnelId && !entryNodesLoading && entryNodes.length === 0 && (
                        <p className="flow-node-hint" style={{ margin: '0.25rem 0 0', color: 'var(--danger)' }}>
                          У цьому тунелі немає жодної точки входу — додайте вузол «Точка входу» в редакторі тунелю.
                        </p>
                      )}
                      {routingMissing && funnelId === '' && (
                        <p className="flow-node-hint" style={{ margin: '0.25rem 0 0', color: 'var(--warning)' }}>
                          Без тунелю й точки входу опублікувати сторінку не вийде — кнопки нікуди б не вели.
                        </p>
                      )}
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                        Один тунель на всю сторінку. Лендінг веде відвідувачів у месенджер сам — не через посилання лідогенерації.
                      </p>
                    </div>
                  )}
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
                  {hasCta && (
                    <div className="field lpe-orb-panel">
                      <label>Кулька месенджера</label>
                      <div className="lpe-orb-row">
                        <span className="lpe-orb-k">Колір</span>
                        <div className="lpe-swatches">
                          <button
                            type="button"
                            className={`lpe-sw-default${config.orb_color === '' ? ' on' : ''}`}
                            onClick={() => patch({ orb_color: '' })}
                            aria-label="Типовий колір теми"
                            title="Типовий (скло)"
                          />
                          {ACCENT_SWATCHES.map((c) => (
                            <button key={c} type="button" className={config.orb_color === c ? 'on' : ''} style={{ background: c }} onClick={() => patch({ orb_color: c })} aria-label={c} />
                          ))}
                          <input type="color" value={config.orb_color || '#ffc061'} onChange={(e) => patch({ orb_color: e.target.value })} aria-label="Свій колір кульки" />
                        </div>
                      </div>
                      <div className="lpe-orb-row">
                        <span className="lpe-orb-k">Розмір</span>
                        <div className="lpe-seg">
                          {ORB_SIZES.map((sz) => (
                            <button key={sz} type="button" className={config.orb_size === sz ? 'on' : ''} onClick={() => patch({ orb_size: sz })}>
                              {ORB_SIZE_LABEL[sz]}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="lpe-orb-row">
                        <span className="lpe-orb-k">Анімація</span>
                        <div className="lpe-seg wrap">
                          {ORB_ANIMATIONS.map((an) => (
                            <button key={an} type="button" className={config.orb_animation === an ? 'on' : ''} onClick={() => patch({ orb_animation: an })}>
                              {ORB_ANIMATION_LABEL[an]}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                        Перетягніть кульку прямо на макеті — позиція збережеться.
                        {config.orb_position && (
                          <>
                            {' '}
                            <button type="button" className="lpe-link-btn lpe-link-neutral" onClick={() => patch({ orb_position: null })}>
                              Скинути позицію
                            </button>
                          </>
                        )}
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
                        Піксель самого лендінга: PageView при відкритті й Lead при кліку на кнопку. Працює незалежно від
                        посилань лідогенерації і не змішується з їхніми конверсіями.
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

                  <Acc title="Політика конфіденційності" filled={!!config.privacy_url}>
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

              {isEditing && (
                <div className="lpe-actions">
                  <button type="button" className="btn btn-ghost lpe-delete" onClick={handleDelete} disabled={deleting}>
                    {deleting ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                    Видалити лендінг
                  </button>
                </div>
              )}
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
