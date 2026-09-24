import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { LeadGenLinkCard, buildLeadGenUrls } from '../components/LeadGenLinks'
import { IconAlert, IconArrowLeft, IconCheckCircle, IconClose, IconCode, IconLink, IconPlus, IconSpinner } from '../components/icons'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

interface FunnelOption {
  id: string
  name: string
}

interface EntryNodeOption {
  id: string
  label: string
}

interface ExistingLink {
  id: string
  name: string
  ref_token: string
  funnel_id: string
  entry_node_id: string | null
  pixel_id: string | null
  // Only ever used to check presence (!= null) — the secret itself never
  // leaves the server, and this UUID reference doesn't expose it either.
  meta_access_token_secret_id: string | null
  meta_test_event_code: string | null
  landing_page_id: string | null
}

interface LandingOption {
  id: string
  name: string
}

export default function LeadGenLinkForm() {
  const navigate = useNavigate()
  const { linkId } = useParams<{ linkId: string }>()
  const isEditing = !!linkId

  const [funnels, setFunnels] = useState<FunnelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [refToken, setRefToken] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [funnelId, setFunnelId] = useState('')
  const [entryNodes, setEntryNodes] = useState<EntryNodeOption[]>([])
  const [entryNodesLoading, setEntryNodesLoading] = useState(false)
  const [entryNodeId, setEntryNodeId] = useState('')
  const [pixelId, setPixelId] = useState('')
  const [metaAccessToken, setMetaAccessToken] = useState('')
  const [hasMetaToken, setHasMetaToken] = useState(false)
  // Live token/pixel-access check, independent of the save flow — 'idle'
  // covers both "nothing typed yet" and "an existing token left untouched"
  // (blank field on edit), so it never fires a request in either case.
  const [tokenCheck, setTokenCheck] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [tokenCheckError, setTokenCheckError] = useState<string | null>(null)
  const [metaTestEventCode, setMetaTestEventCode] = useState('')
  const [landings, setLandings] = useState<LandingOption[]>([])
  const [landingPageId, setLandingPageId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setSaved(false)
      setError(null)
      const [{ data: funnelsData }, { data: landingsData }] = await Promise.all([
        supabase.from('funnels').select('id, name').order('name'),
        supabase.from('landing_pages').select('id, name').eq('status', 'published').order('name'),
      ])
      if (cancelled) return
      setFunnels((funnelsData ?? []) as FunnelOption[])
      setLandings((landingsData ?? []) as LandingOption[])

      if (linkId) {
        const { data } = await supabase
          .from('lead_gen_links')
          .select('id, name, ref_token, funnel_id, entry_node_id, pixel_id, meta_access_token_secret_id, meta_test_event_code, landing_page_id')
          .eq('id', linkId)
          .maybeSingle()
        if (cancelled) return
        const existing = data as ExistingLink | null
        if (!existing) {
          setNotFound(true)
        } else {
          setName(existing.name)
          setFunnelId(existing.funnel_id)
          setEntryNodeId(existing.entry_node_id ?? '')
          setPixelId(existing.pixel_id ?? '')
          setHasMetaToken(!!existing.meta_access_token_secret_id)
          setMetaTestEventCode(existing.meta_test_event_code ?? '')
          setLandingPageId(existing.landing_page_id ?? '')
          setRefToken(existing.ref_token)
        }
      }
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [linkId])

  // Cascades off the funnel choice — a different funnel means a different
  // set of entry nodes, so this only ever repopulates the options list. The
  // selected entryNodeId itself is left alone here: the load effect above
  // sets it once for an existing link, and choosing a new funnel from the
  // select below clears it explicitly (its own onChange), so there's never a
  // race between "just loaded" and "just fetched options for that funnel".
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

  // Live valid/invalid indicator on the token field — entirely separate from
  // handleSave's own submit-time format check below, which still runs
  // regardless of what this shows (Graph API can hiccup; this is a hint, not
  // a gate). Needs both a token AND a pixel: the probe confirms access to
  // THIS pixel specifically, so without one there's nothing to check against.
  useEffect(() => {
    const token = metaAccessToken.trim()
    const pixel = pixelId.trim()

    if (!token || !pixel) {
      setTokenCheck('idle')
      setTokenCheckError(null)
      return
    }

    let cancelled = false
    setTokenCheck('checking')
    setTokenCheckError(null)

    const timer = setTimeout(async () => {
      const accessToken = await getAccessToken()
      if (cancelled) return
      if (!accessToken) {
        setTokenCheck('idle')
        return
      }
      try {
        const res = await fetch('/.netlify/functions/validate-meta-token', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ token, pixelId: pixel }),
        })
        const data = await res.json()
        if (cancelled) return
        if (res.ok && data.valid) {
          setTokenCheck('valid')
        } else {
          setTokenCheck('invalid')
          setTokenCheckError(res.ok ? (data.error ?? 'Токен недійсний') : (data.error ?? 'Не вдалося перевірити токен'))
        }
      } catch {
        if (!cancelled) {
          setTokenCheck('invalid')
          setTokenCheckError('Мережева помилка під час перевірки')
        }
      }
    }, 600)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [metaAccessToken, pixelId])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || !funnelId || !entryNodeId) return
    setSaving(true)
    setError(null)
    setSaved(false)

    // Same regex save-leadgen-link.ts enforces server-side — that check is
    // the real guard, this one just surfaces the same error immediately in
    // the form instead of after a round trip.
    if (metaAccessToken.trim() && !/^[A-Za-z0-9]{40,300}$/.test(metaAccessToken.trim())) {
      setError('Токен доступу має бути одним рядком з латинських літер і цифр, без пробілів чи іншого тексту')
      setSaving(false)
      return
    }

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSaving(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-leadgen-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          id: linkId,
          name: name.trim(),
          funnelId,
          entryNodeId,
          pixelId: pixelId.trim() || undefined,
          metaAccessToken: metaAccessToken.trim() || undefined,
          metaTestEventCode: metaTestEventCode.trim() || undefined,
          // null (not undefined) clears the page on an edit — see save-leadgen-link.ts
          landingPageId: landingPageId || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося зберегти посилання')
      } else {
        setRefToken(data.link.refToken)
        setHasMetaToken(!!data.link.hasMetaToken)
        // The token itself is never echoed back — clear the field so it goes
        // back to reflecting "nothing typed" rather than showing what was
        // just submitted in plain text.
        setMetaAccessToken('')
        setSaved(true)
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/dashboard/leadgentools')}
            style={{ marginBottom: '0.75rem', paddingLeft: 0 }}
          >
            <IconArrowLeft size={15} />
            До списку
          </button>
          <h1 className="page-title">{isEditing ? 'Редагування посилання' : 'Нове посилання'}</h1>
          <p className="page-description">
            {isEditing
              ? 'Змініть назву, тунель або точку входу — посилання лишаться тими самими'
              : 'Оберіть тунель і точку входу — посилання створяться автоматично'}
          </p>
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : notFound ? (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>Посилання не знайдено</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 640 }}>
          <form
            className="card"
            onSubmit={handleSave}
            autoComplete="off"
            style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
          >
            <div className="field">
              <label htmlFor="lgl-name">Назва</label>
              <input
                id="lgl-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="напр. Instagram — літня кампанія"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="lgl-funnel">Тунель</label>
              <select
                id="lgl-funnel"
                className="input"
                value={funnelId}
                onChange={(e) => {
                  setFunnelId(e.target.value)
                  // The previous selection belonged to a different funnel's
                  // entry-node set — never valid to carry across.
                  setEntryNodeId('')
                }}
              >
                <option value="">Оберіть тунель</option>
                {funnels.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="lgl-entry-node">Точка входу</label>
              <select
                id="lgl-entry-node"
                className="input"
                value={entryNodeId}
                onChange={(e) => setEntryNodeId(e.target.value)}
                disabled={!funnelId || entryNodesLoading}
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
            </div>
            <div className="field">
              <label htmlFor="lgl-landing">Лендінг перед месенджером (опційно)</label>
              <select id="lgl-landing" className="input" value={landingPageId} onChange={(e) => setLandingPageId(e.target.value)}>
                <option value="">Без лендінга — одразу в месенджер</option>
                {landings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                {landings.length === 0
                  ? 'Тут з’являться опубліковані лендінги з вкладки «Лендінги».'
                  : 'Відвідувач спершу побачить цю сторінку, а кнопка на ній поведе в месенджер із тим самим click_id.'}
              </p>
            </div>
            <div className="field">
              <label htmlFor="lgl-pixel">Pixel ID (опційно)</label>
              <input
                id="lgl-pixel"
                className="input"
                value={pixelId}
                onChange={(e) => setPixelId(e.target.value)}
                placeholder="напр. 1234567890123456"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
              />
              <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                Потрібен разом із «Відстежувати як конверсію в Meta» на точці входу тунелю — інакше подія в Meta не
                надсилається.
              </p>
            </div>
            <div className="field">
              <label htmlFor="lgl-meta-token">Токен доступу Conversions API (опційно)</label>
              <div className="input-wrap">
                <input
                  id="lgl-meta-token"
                  className="input input-masked"
                  type="text"
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  value={metaAccessToken}
                  onChange={(e) => setMetaAccessToken(e.target.value)}
                  placeholder={hasMetaToken ? 'Збережено — введіть новий, щоб замінити' : 'EAAG...'}
                  style={{ paddingRight: '2.5rem' }}
                />
                {tokenCheck === 'checking' && (
                  <span className="input-suffix-icon" aria-label="Перевірка токена">
                    <IconSpinner size={16} />
                  </span>
                )}
                {tokenCheck === 'valid' && (
                  <span className="input-suffix-icon input-suffix-valid" aria-label="Токен дійсний">
                    <IconCheckCircle size={16} />
                  </span>
                )}
                {tokenCheck === 'invalid' && (
                  <span className="input-suffix-icon input-suffix-invalid" aria-label="Токен недійсний">
                    <IconClose size={16} />
                  </span>
                )}
              </div>
              {tokenCheck === 'invalid' && tokenCheckError && (
                <p className="flow-node-hint" style={{ margin: '0.25rem 0 0', color: 'var(--danger)' }}>
                  {tokenCheckError}
                </p>
              )}
              <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                Свій System User токен саме для цього посилання — незалежний від інших посилань. Не показується
                повторно після збереження; порожнє поле лишає вже збережений токен без змін. Перевірка доступу до
                Pixel ID — лише попередження, збереження вона не блокує.
              </p>
            </div>
            <div className="field">
              <label htmlFor="lgl-meta-test-code" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                Тестовий код події CAPI (опційно)
                {metaTestEventCode.trim() && <span className="badge badge-warning">TEST</span>}
              </label>
              <input
                id="lgl-meta-test-code"
                className="input"
                value={metaTestEventCode}
                onChange={(e) => setMetaTestEventCode(e.target.value)}
                placeholder="напр. TEST12345"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
              />
              <p className="flow-node-hint" style={{ margin: '0.25rem 0 0' }}>
                Щоб побачити подію одразу в Meta Test Events, без очікування.
              </p>
              {metaTestEventCode.trim() && (
                <div className="alert alert-warning" style={{ marginTop: '0.5rem' }}>
                  <IconAlert size={16} />
                  <span>
                    Це тестовий режим — конверсії підуть у Meta Test Events, а не в бойову статистику. Заберіть це
                    поле перед запуском реальної кампанії.
                  </span>
                </div>
              )}
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !name.trim() || !funnelId || !entryNodeId}
              style={{ alignSelf: 'flex-start' }}
            >
              {saving ? <IconSpinner size={16} /> : isEditing ? <IconCheckCircle size={16} /> : <IconPlus size={16} />}
              Зберегти
            </button>
          </form>

          {error && (
            <div className="alert alert-error">
              <IconAlert size={16} />
              <span>{error}</span>
            </div>
          )}

          {saved && (
            <div className="alert" style={{ background: 'var(--success-soft)', color: 'var(--success)', borderColor: 'transparent' }}>
              <IconCheckCircle size={16} />
              <span>Збережено</span>
            </div>
          )}

          {refToken && (
            <LeadGenLinkCard
              name={isEditing ? 'Готові посилання' : 'Готово! Ваші посилання'}
              meta="Скопіюйте потрібне для реклами"
              refToken={refToken}
            />
          )}

          {refToken && <LandingSnippetCard refToken={refToken} />}
        </div>
      )}
    </div>
  )
}

// fbclid only ever lands on the *ad's* click-through URL (the landing page),
// never on the /r/ link itself unless something puts it there first — this
// is that "something": a snippet the advertiser pastes into their landing
// page so a visitor who clicks through to Telegram/WhatsApp/FBM carries
// their fbclid along, letting meta-capi-send.ts build a proper fbc.
function LandingSnippetCard({ refToken }: { refToken: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const urls = buildLeadGenUrls(refToken)
  const snippet = `<script>
(function () {
  var bases = ${JSON.stringify(Object.values(urls))};
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var fbclid = new URLSearchParams(window.location.search).get('fbclid');
    if (!fbclid) return;
    for (var i = 0; i < bases.length; i++) {
      if (a.href.indexOf(bases[i]) === 0 && a.href.indexOf('fbclid=') === -1) {
        a.href += (a.href.indexOf('?') === -1 ? '?' : '&') + 'fbclid=' + encodeURIComponent(fbclid);
      }
    }
  }, true);
})();
</script>`

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing to fall back to.
    }
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setOpen((v) => !v)}
        style={{ alignSelf: 'flex-start' }}
        aria-expanded={open}
      >
        <IconCode size={15} />
        Отримати код для лендінгу
      </button>

      {open && (
        <>
          <p className="flow-node-hint" style={{ margin: 0 }}>
            Вставте цей код у кастомний HTML-блок вашого лендінгу. Він зчитує <code>fbclid</code> з адресного рядка і
            дописує його до посилань вище, коли відвідувач по них клікає — це і дає Meta match quality для конверсії.
          </p>
          <div style={{ position: 'relative' }}>
            <pre
              style={{
                margin: 0,
                padding: '0.75rem',
                borderRadius: 8,
                background: 'var(--bg-subtle)',
                fontSize: '0.75rem',
                lineHeight: 1.5,
                overflowX: 'auto',
                whiteSpace: 'pre',
              }}
            >
              <code>{snippet}</code>
            </pre>
            <button
              type="button"
              className="btn-icon-ghost"
              onClick={handleCopy}
              aria-label="Скопіювати код"
              style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', background: 'var(--surface)' }}
            >
              {copied ? <IconCheckCircle size={14} /> : <IconLink size={14} />}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
