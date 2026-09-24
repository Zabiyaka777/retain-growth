import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'

// The fixed landing templates. Rendered three times: on the public /lp/:slug
// page for the visitor, inside the dashboard editor where the very same markup
// becomes editable in place (`edit` prop), and as a scaled-down thumbnail in
// the landings list — one component, so what the editor sees is exactly what
// ships. Visual system ported from the approved "Pre-chat Landing Concepts v2"
// mockup (themes, native messenger CTAs, drop zone states).

export const LANDING_TEMPLATES = ['minimal', 'problem_solution', 'social_proof', 'hr_vacancy', 'product'] as const
export type LandingTemplateKey = (typeof LANDING_TEMPLATES)[number]
export const LANDING_THEMES = ['white', 'dark', 'rg'] as const
export type LandingTheme = (typeof LANDING_THEMES)[number]
export const CTA_CHANNELS = ['telegram', 'whatsapp', 'fbm'] as const
export type CtaChannel = (typeof CTA_CHANNELS)[number]

export const TEMPLATE_META: Record<LandingTemplateKey, { label: string; hint: string }> = {
  minimal: { label: 'Мінімальний', hint: 'Обкладинка, заголовок поверх, кнопки' },
  problem_solution: { label: 'Біль → рішення', hint: 'Болі, міст, переваги, кнопки' },
  social_proof: { label: 'Соціальний доказ', hint: 'Заголовок, цифра, переваги' },
  hr_vacancy: { label: 'HR-вакансія', hint: 'Картка вакансії без гіпу' },
  product: { label: 'Товар', hint: 'Обкладинка, ціна, характеристики' },
}
export const THEME_META: Record<LandingTheme, string> = { white: 'Світла', dark: 'Темна', rg: 'RG-style' }
export const ACCENT_SWATCHES = ['#ffc061', '#ff6b2c', '#4ade9a', '#4da3ff', '#45cdbb', '#a79bf5']
// `color` is only what the editor's "default" dot shows; the real brand
// styling (gradients, WhatsApp tail, Messenger shimmer) lives in the CSS
// class and is what renders whenever cta.color is empty.
export const CHANNEL_META: Record<CtaChannel, { name: string; cls: string; color: string; sub: string }> = {
  telegram: { name: 'Telegram', cls: 'lp-cta-tg', color: '#26A5E4', sub: 'відповідь ~1 хв' },
  whatsapp: { name: 'WhatsApp', cls: 'lp-cta-wa', color: '#25D366', sub: 'Онлайн · відповідь ~2 хв' },
  fbm: { name: 'Messenger', cls: 'lp-cta-ms', color: '#A033FF', sub: 'Відкриється у застосунку · без реєстрації' },
}
export const IMAGE_ASPECTS = ['square', 'portrait'] as const
export type ImageAspect = (typeof IMAGE_ASPECTS)[number]
export const COUNTDOWN_MODES = ['off', 'deadline', 'cycle'] as const
export type CountdownMode = (typeof COUNTDOWN_MODES)[number]

// Every fixed string a template renders besides headline/subheadline/CTA
// labels. Stored in config.texts; '' there means "use this default", so a
// page keeps following the default wording until someone edits it, and a
// future translation only has to swap this table.
export const TEXT_DEFAULTS = {
  footer_note: 'Без реєстрації · без спаму',
  advantages_title: 'Переваги',
  ps_eyebrow: 'Впізнаєте себе?',
  ps_bridge: 'Ось що ми зробили інакше',
  stat_label: 'клієнтів уже написали нам',
  hr_chip: 'Вакансія',
  hr_section_title: 'Вимоги та умови',
  orb_title: 'Де вам зручніше написати?',
  countdown_label: 'До кінця пропозиції',
}
export type TextKey = keyof typeof TEXT_DEFAULTS
export type LandingTexts = Record<TextKey, string>
const FOOTER_DEFAULT: Partial<Record<LandingTemplateKey, string>> = { hr_vacancy: 'Відповідаємо в робочий час' }

export type CtaType = 'funnel' | 'link'
export interface LandingCta {
  channel: CtaChannel
  label: string
  enabled: boolean
  /* 'funnel' goes back through /r/ so the click_id survives; 'link' is a
     plain outbound href with no attribution. */
  type: CtaType
  url: string
  /* '' = the channel's brand styling (or the page accent for a link) */
  color: string
  /* line under the label; '' = CHANNEL_META[channel].sub (host for a link) */
  sub: string
}
export interface LandingAdvantage {
  title: string
  text: string
}
export interface LandingConfig {
  theme: LandingTheme
  headline: string
  subheadline: string
  image_url: string
  image_aspect: ImageAspect
  /* '' = the theme's own ink / muted colour */
  headline_color: string
  subheadline_color: string
  bullets: string[]
  accent_color: string
  ctas: LandingCta[]
  urgency_text: string
  show_urgency: boolean
  advantages: LandingAdvantage[]
  price_highlight: string
  countdown_mode: CountdownMode
  /* ISO timestamp for 'deadline' */
  countdown_deadline_at: string
  /* period for 'cycle', 1–168 */
  countdown_cycle_hours: number
  privacy_url: string
  privacy_label: string
  texts: LandingTexts
  seo_title: string
  seo_description: string
  head_code: string
  body_code: string
  fb_pixel_id: string
  tiktok_pixel_id: string
  google_tag_id: string
}

export const EMPTY_CONFIG: LandingConfig = {
  theme: 'rg',
  headline: '',
  subheadline: '',
  image_url: '',
  image_aspect: 'square',
  headline_color: '',
  subheadline_color: '',
  bullets: [],
  accent_color: '#ffc061',
  ctas: [
    { channel: 'telegram', label: 'Написати в Telegram', enabled: true, type: 'funnel', url: '', color: '', sub: '' },
    { channel: 'whatsapp', label: 'Написати в WhatsApp', enabled: false, type: 'funnel', url: '', color: '', sub: '' },
    { channel: 'fbm', label: 'Написати в Messenger', enabled: false, type: 'funnel', url: '', color: '', sub: '' },
  ],
  urgency_text: '',
  show_urgency: false,
  advantages: [],
  price_highlight: '',
  countdown_mode: 'off',
  countdown_deadline_at: '',
  countdown_cycle_hours: 24,
  privacy_url: '',
  privacy_label: 'Політика конфіденційності',
  texts: Object.fromEntries(Object.keys(TEXT_DEFAULTS).map((k) => [k, ''])) as LandingTexts,
  seo_title: '',
  seo_description: '',
  head_code: '',
  body_code: '',
  fb_pixel_id: '',
  tiktok_pixel_id: '',
  google_tag_id: '',
}

// Rows saved before a field existed lack it; arrays and nested objects would
// survive a shallow spread half-filled, so they are merged per item.
export function withConfigDefaults(raw: Partial<LandingConfig> | null | undefined): LandingConfig {
  const r = raw ?? {}
  const ctas = Array.isArray(r.ctas) && r.ctas.length ? r.ctas : EMPTY_CONFIG.ctas
  return {
    ...EMPTY_CONFIG,
    ...r,
    ctas: EMPTY_CONFIG.ctas.map((d) => ({ ...d, ...(ctas.find((c) => c.channel === d.channel) ?? {}) })),
    advantages: Array.isArray(r.advantages) ? r.advantages : [],
    bullets: Array.isArray(r.bullets) ? r.bullets : [],
    texts: { ...EMPTY_CONFIG.texts, ...(r.texts ?? {}) },
  }
}

export type ImageUploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number; name: string; size: number }
  | { kind: 'error'; message: string }

export interface EditApi {
  onChange: (patch: Partial<LandingConfig>) => void
  onImageFile: (file: File) => void
  upload: ImageUploadState
}

interface Props {
  templateKey: LandingTemplateKey
  config: LandingConfig
  ctaHref: (channel: CtaChannel) => string
  /* public page only: fires before the browser follows a CTA (conversion tracking) */
  onCta?: (cta: LandingCta) => void
  edit?: EditApi
  /* thumbnail in the list: no interaction, no observers, no orb */
  static?: boolean
}

/* ---------- icons (from the mockup) ---------- */
const ICO = {
  tg: (
    <svg viewBox="0 0 24 24">
      <path d="M3.4 20.4a1 1 0 0 0 1.4 1l16.6-8.5a1 1 0 0 0 0-1.8L4.8 2.6a1 1 0 0 0-1.4 1L5 10.4a1 1 0 0 0 .8.7l8.3.9-8.3.9a1 1 0 0 0-.8.7Z" />
    </svg>
  ),
  wa: (
    <svg viewBox="0 0 24 24">
      <path d="M17.5 14.4c-.3-.1-1.8-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.1-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6l.4-.5.3-.5c.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5.1 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.8-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3ZM12 22h0a9.9 9.9 0 0 1-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A9.9 9.9 0 0 1 2.2 12C2.2 6.5 6.6 2.1 12.1 2.1c2.6 0 5.1 1 7 2.9a9.8 9.8 0 0 1 2.9 7c0 5.4-4.5 9.9-9.9 9.9Z" />
    </svg>
  ),
  ms: (
    <svg viewBox="0 0 24 24">
      <defs>
        <linearGradient id="lpMsGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00B2FF" />
          <stop offset=".4" stopColor="#006AFF" />
          <stop offset=".7" stopColor="#A033FF" />
          <stop offset="1" stopColor="#FF5280" />
        </linearGradient>
      </defs>
      <path fill="url(#lpMsGrad)" fillRule="evenodd" d="M12 2C6.5 2 2.2 6.1 2.2 11.6c0 3 1.2 5.6 3.3 7.4v3.7l3.4-1.9c.9.3 2 .4 3.1.4 5.5 0 9.8-4.1 9.8-9.6S17.5 2 12 2Zm1 12.9-2.5-2.7-4.9 2.7 5.4-5.7 2.6 2.7 4.8-2.7-5.4 5.7Z" />
    </svg>
  ),
  arr: (
    <svg viewBox="0 0 24 24">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 24 24">
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  ),
  img: (
    <svg viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M21 16l-4.5-4.5L8 20" />
      <path d="M3 17l3-3 3 3" />
    </svg>
  ),
  ext: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24">
      <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12Z" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 2.5 17.5A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  ),
}
const CHANNEL_ICON: Record<CtaChannel, ReactNode> = { telegram: ICO.tg, whatsapp: ICO.wa, fbm: ICO.ms }

/* ---------- inline editable text ---------- */
function Editable({
  value,
  onCommit,
  edit,
  className,
  placeholder,
  tag = 'span',
  multiline,
  style,
}: {
  value: string
  onCommit?: (v: string) => void
  edit: boolean
  className?: string
  placeholder: string
  tag?: 'span' | 'h1' | 'h2' | 'p' | 'div'
  multiline?: boolean
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLElement>(null)
  const Tag = tag as 'span'
  // React must not fight the browser for the text node while the user types:
  // keep the element uncontrolled and only sync from props when not focused.
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value
  }, [value])
  if (!edit) return <Tag className={className} style={style}>{value || placeholder}</Tag>
  return (
    <Tag
      ref={ref as never}
      className={`${className ?? ''} lp-edit`}
      style={style}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onBlur={(e) => onCommit?.((e.currentTarget.textContent ?? '').replace(/\n{2,}/g, '\n').trim())}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' && !multiline) {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') e.currentTarget.blur()
      }}
      onPaste={(e) => {
        e.preventDefault()
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
      }}
    />
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className={`lp-tgl${on ? ' on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} title={label}>
      <i />
      <span>{label}</span>
    </button>
  )
}

/* ---------- colour dots (editor only) ----------
   The same swatch row as the "Акцент" picker in the settings panel
   (ACCENT_SWATCHES), so the page has one palette rather than a second,
   competing one. The first dot is "default" — back to the theme/brand colour.
   mouseDown is swallowed so picking a colour doesn't blur (and hide) the text
   being edited next to it. */
function ColorDots({ value, onChange, def, label }: { value: string; onChange: (v: string) => void; def: string; label: string }) {
  const keep = (e: React.MouseEvent) => e.preventDefault()
  return (
    <div className="lp-dots" role="group" aria-label={label}>
      <button type="button" className={`lp-dot def${value ? '' : ' on'}`} style={{ ['--c' as string]: def }} onMouseDown={keep} onClick={() => onChange('')} title="Типовий колір" aria-label="Типовий колір" />
      {ACCENT_SWATCHES.map((c) => (
        <button key={c} type="button" className={`lp-dot${value === c ? ' on' : ''}`} style={{ ['--c' as string]: c }} onMouseDown={keep} onClick={() => onChange(c)} aria-label={c} />
      ))}
      <label className="lp-dot pick" title="Свій колір" onMouseDown={(e) => e.stopPropagation()}>
        <input type="color" value={value || def} onChange={(e) => onChange(e.target.value)} aria-label="Свій колір" />
      </label>
    </div>
  )
}

/* Fixed copy (eyebrows, section titles, footer note…) — shown with its
   default until edited; committing the default text (or clearing it) stores
   '' so the page keeps following the default wording. */
function T({ config, edit, k, def, className, tag }: { config: LandingConfig; edit?: EditApi; k: TextKey; def?: string; className?: string; tag?: 'span' | 'div' | 'p' }) {
  const fallback = def ?? TEXT_DEFAULTS[k]
  return (
    <Editable
      tag={tag}
      className={className}
      value={config.texts[k] || fallback}
      edit={!!edit}
      placeholder={fallback}
      onCommit={(v) => edit?.onChange({ texts: { ...config.texts, [k]: v === fallback ? '' : v } })}
    />
  )
}

function isLight(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45
}

/* ---------- hero image / drop zone ---------- */
function HeroImage({ config, edit, className }: { config: LandingConfig; edit?: EditApi; className: string }) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const has = !!config.image_url
  const aspect = `ar-${config.image_aspect === 'portrait' ? 'portrait' : 'square'}`

  if (!edit) {
    if (!has) return null
    return (
      <div className={`lp-hero-img ${className} ${aspect}`}>
        <img src={config.image_url} alt="" decoding="async" />
      </div>
    )
  }

  const up = edit.upload
  const state = over ? 'over' : up.kind === 'uploading' ? 'uploading' : up.kind === 'error' ? 'error' : has ? 'done' : 'idle'
  function onDrop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) edit!.onImageFile(f)
  }
  return (
    <div
      className={`lp-hero-img lp-dz ${className} ${aspect}`}
      data-state={state}
      onDragEnter={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) edit.onImageFile(f)
          e.target.value = ''
        }}
      />
      {has && <img src={config.image_url} alt="" decoding="async" />}
      <div className="lp-ar" role="group" aria-label="Співвідношення сторін">
        {IMAGE_ASPECTS.map((a) => (
          <button key={a} type="button" className={config.image_aspect === a ? 'on' : ''} onClick={() => edit.onChange({ image_aspect: a })}>
            {a === 'square' ? '1:1' : '2:3'}
          </button>
        ))}
      </div>
      <svg className="lp-dz-bd" aria-hidden="true">
        <rect />
      </svg>
      {(state === 'idle' || state === 'over') && (
        <button type="button" className="lp-dz-st lp-dz-idle" onClick={() => inputRef.current?.click()}>
          <span className="lp-dz-icn">
            {ICO.img}
            <i className="lp-dz-spark">{ICO.check}</i>
          </span>
          <span className="lp-dz-t1">{over ? 'Відпустіть — і ми його заберемо' : 'Перетягніть зображення сюди або оберіть файл'}</span>
          <span className="lp-dz-t2">{over ? 'Один файл · PNG, JPG, WebP' : 'PNG · JPG · WebP · до 4 MB'}</span>
        </button>
      )}
      {state === 'uploading' && up.kind === 'uploading' && (
        <div className="lp-dz-st lp-dz-up">
          <div className="lp-dz-fname">
            {up.name} <small>{(up.size / 1048576).toFixed(1)} MB</small>
          </div>
          <div className="lp-dz-fstep">
            <i />
            {up.progress < 100 ? 'Завантажуємо…' : 'Зберігаємо…'}
          </div>
          <div className="lp-dz-barrow">
            <div className="lp-dz-bar">
              <i style={{ ['--p' as string]: `${up.progress}%` }} />
            </div>
            <span className="lp-dz-pct">{Math.round(up.progress)}%</span>
          </div>
        </div>
      )}
      {state === 'error' && up.kind === 'error' && (
        <div className="lp-dz-st lp-dz-err">
          <span className="lp-dz-errI">{ICO.warn}</span>
          <span className="lp-dz-t1 err">{up.message}</span>
          <button type="button" className="lp-dz-btn" onClick={() => inputRef.current?.click()}>
            Обрати інший файл
          </button>
        </div>
      )}
      {state === 'done' && (
        <div className="lp-dz-st lp-dz-done">
          <span className="lp-dz-ok">{ICO.check} Завантажено</span>
          <div className="lp-dz-acts">
            <button type="button" className="lp-dz-btn p" onClick={() => inputRef.current?.click()}>
              Замінити
            </button>
            <button type="button" className="lp-dz-btn danger" onClick={() => edit.onChange({ image_url: '' })}>
              Видалити
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- native CTA buttons ---------- */
function ctaHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Вкажіть посилання'
  }
}

function CtaBlock({ config, ctaHref, onCta, edit, compact }: { config: LandingConfig; ctaHref: Props['ctaHref']; onCta?: Props['onCta']; edit?: EditApi; compact?: boolean }) {
  const list = edit ? config.ctas : config.ctas.filter((c) => c.enabled)
  if (list.length === 0) return null
  function setCta(channel: CtaChannel, patch: Partial<LandingCta>) {
    edit?.onChange({ ctas: config.ctas.map((c) => (c.channel === channel ? { ...c, ...patch } : c)) })
  }
  return (
    <div className={`lp-ctas${compact ? ' compact' : ''}`}>
      {list.map((c) => {
        const meta = CHANNEL_META[c.channel]
        const isLink = c.type === 'link'
        const color = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : ''
        // A custom colour replaces the brand gradient on a messenger button;
        // on a link button it just retints it (the link style runs off --accent).
        const cls = isLink ? 'lp-cta-link' : color ? `lp-cta-custom${isLight(color) ? ' ink' : ''}` : meta.cls
        const style = color ? { [isLink ? '--accent' : '--cta']: color } : undefined
        const defSub = isLink ? ctaHost(c.url) : meta.sub
        const inner = (
          <>
            <span className="lp-cta-ico">{isLink ? ICO.ext : CHANNEL_ICON[c.channel]}</span>
            <span className="lp-cta-txt">
              <Editable
                className="lp-cta-lbl"
                value={c.label}
                edit={!!edit && !compact}
                placeholder={isLink ? 'Дізнатись більше' : `Написати в ${meta.name}`}
                onCommit={(v) => setCta(c.channel, { label: v || (isLink ? 'Дізнатись більше' : `Написати в ${meta.name}`) })}
              />
              {!compact && (
                <span className="lp-cta-sb">
                  {!isLink && !color && c.channel === 'whatsapp' && <i className="lp-cta-dot" />}
                  <Editable
                    value={c.sub || defSub}
                    edit={!!edit}
                    placeholder={defSub}
                    onCommit={(v) => setCta(c.channel, { sub: v === defSub ? '' : v })}
                  />
                </span>
              )}
            </span>
            <span className="lp-cta-arr">{ICO.arr}</span>
          </>
        )
        if (edit && !compact) {
          return (
            <div key={c.channel} className={`lp-cta-wrap${c.enabled ? '' : ' off'}`}>
              <div className={`lp-cta ${cls}`} style={style}>{inner}</div>
              <div className="lp-cta-ctl">
                <ColorDots value={color} def={isLink ? config.accent_color : meta.color} onChange={(v) => setCta(c.channel, { color: v })} label={`Колір кнопки ${meta.name}`} />
                <div className="lp-cta-type">
                  <button type="button" className={!isLink ? 'on' : ''} onClick={() => setCta(c.channel, { type: 'funnel' })}>
                    {meta.name}
                  </button>
                  <button type="button" className={isLink ? 'on' : ''} onClick={() => setCta(c.channel, { type: 'link' })}>
                    Лінк
                  </button>
                </div>
                <Toggle on={c.enabled} onChange={(v) => setCta(c.channel, { enabled: v })} label="Показати" />
              </div>
              {isLink && (
                <input
                  className={`lp-cta-url${c.enabled && !/^https?:\/\//i.test(c.url) ? ' bad' : ''}`}
                  value={c.url}
                  placeholder="https://…"
                  onChange={(e) => setCta(c.channel, { url: e.target.value.trim() })}
                  aria-label={`Посилання для кнопки ${c.label}`}
                />
              )}
            </div>
          )
        }
        if (isLink) {
          return (
            <a key={c.channel} className={`lp-cta ${cls}`} style={style} href={c.url || '#'} target="_blank" rel="noopener noreferrer nofollow" onClick={() => onCta?.(c)}>
              {inner}
            </a>
          )
        }
        return (
          <a key={c.channel} className={`lp-cta ${cls}`} style={style} href={ctaHref(c.channel)} onClick={() => onCta?.(c)}>
            {inner}
          </a>
        )
      })}
    </div>
  )
}

/* ---------- bullets ---------- */
function Bullets({ config, edit, variant, placeholder }: { config: LandingConfig; edit?: EditApi; variant: 'pain' | 'check' | 'chip' | 'plain'; placeholder: string }) {
  const items = config.bullets
  function set(i: number, v: string) {
    const next = items.slice()
    if (v) next[i] = v
    else next.splice(i, 1)
    edit?.onChange({ bullets: next })
  }
  if (!edit && items.length === 0) return null
  const cls = variant === 'pain' ? 'lp-pains' : variant === 'chip' ? 'lp-chips' : variant === 'plain' ? 'lp-plain' : 'lp-bul'
  return (
    <ul className={cls}>
      {items.map((b, i) => (
        <li key={i}>
          {variant === 'chip' && <span className="lp-chip-ck">{ICO.check}</span>}
          {variant === 'pain' && <span className="lp-pain-x">{ICO.x}</span>}
          {variant === 'check' && (
            <>
              <span className="lp-bul-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="lp-bul-ck">{ICO.check}</span>
            </>
          )}
          <Editable value={b} edit={!!edit} placeholder={placeholder} onCommit={(v) => set(i, v)} />
          {edit && (
            <button type="button" className="lp-rm" onClick={() => set(i, '')} aria-label="Прибрати пункт">
              {ICO.x}
            </button>
          )}
        </li>
      ))}
      {edit && items.length < 8 && (
        <li className="lp-add">
          <button type="button" onClick={() => edit.onChange({ bullets: [...items, placeholder] })}>
            + Додати пункт
          </button>
        </li>
      )}
    </ul>
  )
}

/* ---------- advantages (problem_solution) ---------- */
function Advantages({ config, edit }: { config: LandingConfig; edit?: EditApi }) {
  const items = config.advantages
  if (!edit && items.length === 0) return null
  function set(i: number, patch: Partial<LandingAdvantage>) {
    edit?.onChange({ advantages: items.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
  }
  return (
    <div className="lp-advs">
      <T config={config} edit={edit} k="advantages_title" tag="div" className="lp-advs-h" />
      {items.map((a, i) => (
        <div className="lp-adv" key={i}>
          <Editable className="lp-adv-t" value={a.title} edit={!!edit} placeholder="Заголовок переваги" onCommit={(v) => set(i, { title: v })} />
          <Editable className="lp-adv-x" value={a.text} edit={!!edit} multiline placeholder="Коротко, одне-два речення" onCommit={(v) => set(i, { text: v })} />
          {edit && (
            <button
              type="button"
              className="lp-rm"
              onClick={() => edit.onChange({ advantages: items.filter((_, j) => j !== i) })}
              aria-label="Прибрати перевагу"
            >
              {ICO.x}
            </button>
          )}
        </div>
      ))}
      {edit && items.length < 6 && (
        <button
          type="button"
          className="lp-adv-add"
          onClick={() => edit.onChange({ advantages: [...items, { title: 'Заголовок переваги', text: 'Коротко, одне-два речення' }] })}
        >
          + Додати перевагу
        </button>
      )}
    </div>
  )
}

function Urgency({ config, edit }: { config: LandingConfig; edit?: EditApi }) {
  if (!edit && (!config.show_urgency || !config.urgency_text)) return null
  return (
    <div className={`lp-proof${config.show_urgency ? '' : ' off'}`}>
      <span className="lp-avs">
        <i>ОК</i>
        <i>ДМ</i>
        <i>ІВ</i>
        <i className="more">+</i>
      </span>
      <Editable
        value={config.urgency_text}
        edit={!!edit}
        placeholder="1 240 людей уже замовили. Залишилось 86 місць."
        onCommit={(v) => edit?.onChange({ urgency_text: v })}
      />
      {edit && <Toggle on={config.show_urgency} onChange={(v) => edit.onChange({ show_urgency: v })} label="Тригер" />}
    </div>
  )
}

function Foot({ config, edit, def }: { config: LandingConfig; edit?: EditApi; def?: string }) {
  const showPrivacy = !!edit || !!config.privacy_url
  return (
    <footer className="lp-foot">
      <T config={config} edit={edit} k="footer_note" def={def ?? TEXT_DEFAULTS.footer_note} />
      {showPrivacy &&
        (edit ? (
          <Editable
            className="lp-foot-privacy"
            value={config.privacy_label}
            edit
            placeholder="Політика конфіденційності"
            onCommit={(v) => edit.onChange({ privacy_label: v || 'Політика конфіденційності' })}
          />
        ) : (
          <a className="lp-foot-privacy" href={config.privacy_url} target="_blank" rel="noopener noreferrer nofollow">
            {config.privacy_label || 'Політика конфіденційності'}
          </a>
        ))}
    </footer>
  )
}

/* ---------- chat orb ----------
   A quiet, semi-transparent button that opens a compact menu of every CTA
   enabled on the page — "open it wherever suits you". Same hrefs and click
   tracking as the main buttons, so it is just a second entry point to them. */
function OrbMenu({ config, ctaHref, onCta, edit }: { config: LandingConfig; ctaHref: Props['ctaHref']; onCta?: Props['onCta']; edit?: EditApi }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const list = config.ctas.filter((c) => c.enabled)
  if (list.length === 0) return null
  return (
    <div ref={wrap} className={`lp-orb-wrap${open ? ' open' : ''}`}>
      <button type="button" className="lp-orb" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={config.texts.orb_title || TEXT_DEFAULTS.orb_title}>
        {open ? ICO.x : ICO.chat}
      </button>
      <div className="lp-orb-menu" role="menu" aria-hidden={!open}>
        <T config={config} edit={edit} k="orb_title" tag="div" className="lp-orb-title" />
        {list.map((c) => {
          const isLink = c.type === 'link'
          const color = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : isLink ? config.accent_color : CHANNEL_META[c.channel].color
          return (
            <a
              key={c.channel}
              role="menuitem"
              tabIndex={open ? 0 : -1}
              className={`lp-orb-item${isLight(color) ? ' ink' : ''}`}
              style={{ ['--c' as string]: color }}
              href={edit ? '#' : isLink ? c.url || '#' : ctaHref(c.channel)}
              {...(isLink && !edit ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
              onClick={(e) => {
                if (edit) e.preventDefault()
                else onCta?.(c)
              }}
            >
              <span className="lp-orb-ico">{isLink ? ICO.ext : CHANNEL_ICON[c.channel]}</span>
              <span className="lp-orb-lbl">{isLink ? c.label : CHANNEL_META[c.channel].name}</span>
            </a>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- sticky compact CTA (public only) ---------- */
function StickyCta({ config, ctaHref, onCta, anchor }: { config: LandingConfig; ctaHref: Props['ctaHref']; onCta?: Props['onCta']; anchor: React.RefObject<HTMLDivElement | null> }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = anchor.current
    if (!el) return
    const root = el.closest('.lp-scroll') as Element | null
    const io = new IntersectionObserver(
      (es) => {
        const e = es[0]
        setOn(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0))
      },
      { root: root && root !== document.documentElement ? root : null, threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [anchor])
  const first = config.ctas.find((c) => c.enabled)
  if (!first) return null
  return (
    <div className={`lp-sticky${on ? ' on' : ''}`}>
      <CtaBlock config={{ ...config, ctas: [first] }} ctaHref={ctaHref} onCta={onCta} compact />
    </div>
  )
}

// Hoisted (not closures inside LandingTemplate): a component defined during
// render gets a new identity every time, so React would remount the
// contentEditable on each keystroke-driven state change and drop focus/text.
// What the "default" dot shows for each theme (mirrors --lp-ink / --lp-muted).
const THEME_INK: Record<LandingTheme, { ink: string; muted: string }> = {
  white: { ink: '#0c0f14', muted: '#5d6572' },
  dark: { ink: '#f3efe8', muted: '#9d988f' },
  rg: { ink: '#f5f6f8', muted: '#8a93a3' },
}
function H({ config, edit, big, placeholder }: { config: LandingConfig; edit?: EditApi; big?: boolean; placeholder?: string }) {
  const color = config.headline_color || undefined
  const h = (
    <Editable
      tag="h1"
      className={`lp-hl${big ? ' big' : ''}${color ? ' tinted' : ''}`}
      style={color ? { color } : undefined}
      value={config.headline}
      edit={!!edit}
      placeholder={placeholder ?? 'Ваш заголовок'}
      onCommit={(v) => edit?.onChange({ headline: v })}
    />
  )
  if (!edit) return h
  return (
    <div className="lp-colorable">
      {h}
      <ColorDots value={config.headline_color} def={THEME_INK[config.theme].ink} onChange={(v) => edit.onChange({ headline_color: v })} label="Колір заголовка" />
    </div>
  )
}
function Sub({ config, edit, className, tag, placeholder }: { config: LandingConfig; edit?: EditApi; className?: string; tag?: 'p' | 'h2'; placeholder: string }) {
  const color = config.subheadline_color || undefined
  const p = (
    <Editable
      tag={tag ?? 'p'}
      className={`${className ?? 'lp-sub'}${color ? ' tinted' : ''}`}
      style={color ? { color } : undefined}
      value={config.subheadline}
      edit={!!edit}
      multiline
      placeholder={placeholder}
      onCommit={(v) => edit?.onChange({ subheadline: v })}
    />
  )
  if (!edit) return p
  return (
    <div className="lp-colorable">
      {p}
      <ColorDots value={config.subheadline_color} def={THEME_INK[config.theme].muted} onChange={(v) => edit.onChange({ subheadline_color: v })} label="Колір підзаголовка" />
    </div>
  )
}

/* ---------- countdown (product) ----------
   Client-only. 'deadline' counts to a fixed moment and disappears once it
   passes; 'cycle' restarts every N hours, anchored to the visitor's local
   midnight so a 24h cycle resets at their 00:00 rather than at UTC's. */
const CYCLE_ANCHOR = new Date(2024, 0, 1).getTime()
function countdownLeft(config: LandingConfig, now: number) {
  if (config.countdown_mode === 'deadline') {
    const t = Date.parse(config.countdown_deadline_at)
    return Number.isFinite(t) ? t - now : null
  }
  if (config.countdown_mode === 'cycle') {
    const period = Math.min(Math.max(config.countdown_cycle_hours || 24, 1), 168) * 3600e3
    return period - ((((now - CYCLE_ANCHOR) % period) + period) % period)
  }
  return null
}
function Countdown({ config, edit, live }: { config: LandingConfig; edit?: EditApi; live: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  const on = config.countdown_mode !== 'off'
  useEffect(() => {
    if (!on || !live) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [on, live])
  if (!on) return null
  const left = countdownLeft(config, now)
  if (left === null) return edit ? <div className="lp-cd off">Вкажіть дату завершення в налаштуваннях</div> : null
  if (left <= 0 && !edit) return null
  const s = Math.max(0, Math.floor(left / 1000))
  const d = Math.floor(s / 86400)
  const parts = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0'))
  return (
    <div className="lp-cd" role="timer" aria-live="off">
      <T config={config} edit={edit} k="countdown_label" className="lp-cd-l" />
      <div className="lp-cd-t">
        {d > 0 && (
          <>
            <b>{d}</b>
            <i className="u">д</i>
          </>
        )}
        <b>{parts[0]}</b>
        <i>:</i>
        <b>{parts[1]}</b>
        <i>:</i>
        <b>{parts[2]}</b>
      </div>
    </div>
  )
}

/* ---------- the page ---------- */
export function LandingTemplate({ templateKey, config, ctaHref, onCta, edit, static: isStatic }: Props) {
  const accent = /^#[0-9a-f]{6}$/i.test(config.accent_color) ? config.accent_color : '#ffc061'
  const ctaAnchor = useRef<HTMLDivElement>(null)
  const isEdit = !!edit

  return (
    <div
      className={`lp lp-${templateKey}${isEdit ? ' editing' : ''}${isStatic ? ' static' : ''}`}
      data-theme={config.theme}
      style={{ ['--accent' as string]: accent }}
      aria-hidden={isStatic || undefined}
    >
      <div className="lp-scroll">
        <div className="lp-inner">
          <div className="lp-fx" aria-hidden="true" />

          {templateKey === 'minimal' && (
            <section className="lp-tpl">
              <div className="lp-cover">
                <HeroImage config={config} edit={edit} className="lp-cover-img" />
                <div className="lp-cover-scrim" aria-hidden="true" />
                <div className="lp-cover-copy">
                  <H config={config} edit={edit} big />
                </div>
              </div>
              <div className="lp-body">
                <Sub config={config} edit={edit} placeholder="Опишіть переваги, чому людина має обрати саме вас" />
                <Bullets config={config} edit={edit} variant="chip" placeholder="Перевага" />
                <div ref={ctaAnchor}>
                  <CtaBlock config={config} ctaHref={ctaHref} onCta={onCta} edit={edit} />
                </div>
                <Foot config={config} edit={edit} />
              </div>
            </section>
          )}

          {templateKey === 'product' && (
            <section className="lp-tpl">
              <div className="lp-cover">
                <HeroImage config={config} edit={edit} className="lp-cover-img" />
                <div className="lp-cover-scrim" aria-hidden="true" />
                <div className="lp-cover-copy">
                  <H config={config} edit={edit} big placeholder="Назва товару" />
                </div>
              </div>
              <div className="lp-body">
                {(isEdit || config.price_highlight) && (
                  <div className="lp-price">
                    <Editable
                      className="lp-price-v"
                      value={config.price_highlight}
                      edit={isEdit}
                      placeholder="від 590 ₴"
                      onCommit={(v) => edit?.onChange({ price_highlight: v })}
                    />
                  </div>
                )}
                <Countdown config={config} edit={edit} live={!isStatic} />
                <Sub config={config} edit={edit} placeholder="Один-два речення про товар." />
                <Bullets config={config} edit={edit} variant="plain" placeholder="Характеристика" />
                <Urgency config={config} edit={edit} />
                <div ref={ctaAnchor}>
                  <CtaBlock config={config} ctaHref={ctaHref} onCta={onCta} edit={edit} />
                </div>
                <Foot config={config} edit={edit} />
              </div>
            </section>
          )}

          {templateKey === 'problem_solution' && (
            <section className="lp-tpl">
              <div className="lp-ps-problem">
                <div className="lp-live">
                  <i />
                  <T config={config} edit={edit} k="ps_eyebrow" />
                </div>
                <H config={config} edit={edit} placeholder="Питання-біль, яке впізнає ваш клієнт?" />
                <Sub config={config} edit={edit} placeholder="Міст: чому так буває і що ви зробили інакше." />
                <Bullets config={config} edit={edit} variant="pain" placeholder="Біль клієнта" />
              </div>
              <div className="lp-ps-bridge">
                <span className="lp-ps-ln" />
                <span className="lp-ps-bl">
                  {ICO.down} <T config={config} edit={edit} k="ps_bridge" />
                </span>
              </div>
              <div className="lp-body">
                <div className="lp-hero-card">
                  <HeroImage config={config} edit={edit} className="lp-card-img" />
                </div>
                <Advantages config={config} edit={edit} />
                <Urgency config={config} edit={edit} />
                <div ref={ctaAnchor}>
                  <CtaBlock config={config} ctaHref={ctaHref} onCta={onCta} edit={edit} />
                </div>
                <Foot config={config} edit={edit} />
              </div>
            </section>
          )}

          {templateKey === 'social_proof' && (
            <section className="lp-tpl">
              <div className="lp-body lp-sp">
                {/* h1 is the headline and stays the visually dominant element;
                    the stat is a supporting h2 under it, not a bigger <p>. */}
                <H config={config} edit={edit} big />
                <div className="lp-stat">
                  <Sub config={config} edit={edit} tag="h2" className="lp-stat-n" placeholder="12 480+" />
                  <T config={config} edit={edit} k="stat_label" tag="div" className="lp-stat-l" />
                </div>
                <Bullets config={config} edit={edit} variant="check" placeholder="Перевага" />
                <div className="lp-hero-card">
                  <HeroImage config={config} edit={edit} className="lp-card-img" />
                </div>
                <Urgency config={config} edit={edit} />
                <div ref={ctaAnchor}>
                  <CtaBlock config={config} ctaHref={ctaHref} onCta={onCta} edit={edit} />
                </div>
                <Foot config={config} edit={edit} />
              </div>
            </section>
          )}

          {templateKey === 'hr_vacancy' && (
            <section className="lp-tpl">
              <div className="lp-body lp-hr">
                <T config={config} edit={edit} k="hr_chip" className="lp-chip" />
                <H config={config} edit={edit} placeholder="Назва вакансії" />
                <Sub config={config} edit={edit} className="lp-hr-meta" placeholder="Компанія · формат роботи · локація" />
                {(isEdit || config.price_highlight) && (
                  <div className="lp-salary">
                    <Editable
                      className="lp-salary-v"
                      value={config.price_highlight}
                      edit={isEdit}
                      placeholder="28 000 ₴ + чайові"
                      onCommit={(v) => edit?.onChange({ price_highlight: v })}
                    />
                  </div>
                )}
                <div className="lp-hero-card small">
                  <HeroImage config={config} edit={edit} className="lp-card-img" />
                </div>
                <T config={config} edit={edit} k="hr_section_title" tag="div" className="lp-hr-sec" />
                <Bullets config={config} edit={edit} variant="plain" placeholder="Вимога або умова" />
                <div ref={ctaAnchor}>
                  <CtaBlock config={config} ctaHref={ctaHref} onCta={onCta} edit={edit} />
                </div>
                <Foot config={config} edit={edit} def={FOOTER_DEFAULT.hr_vacancy} />
              </div>
            </section>
          )}

          {!isEdit && !isStatic && <StickyCta config={config} ctaHref={ctaHref} onCta={onCta} anchor={ctaAnchor} />}
        </div>
      </div>
      {!isStatic && <OrbMenu config={config} ctaHref={ctaHref} onCta={onCta} edit={edit} />}
    </div>
  )
}
