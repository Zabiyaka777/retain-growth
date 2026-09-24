import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { IconAlert, IconBuilding, IconCheckCircle, IconPlug, IconSparkles, IconSpinner } from '../components/icons'

type Tab = 'integrations' | 'organization' | 'ai'

const TABS: Tab[] = ['integrations', 'organization', 'ai']

export default function Settings() {
  // The tab lives in the URL so /dashboard/settings?tab=ai is linkable — the
  // retired /dashboard/ai route redirects straight to it.
  const [searchParams, setSearchParams] = useSearchParams()
  const paramTab = searchParams.get('tab') as Tab | null
  const tab: Tab = paramTab && TABS.includes(paramTab) ? paramTab : 'integrations'

  function selectTab(next: Tab) {
    setSearchParams(next === 'integrations' ? {} : { tab: next }, { replace: true })
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Налаштування</h1>
          <p className="page-description">Керуйте каналами, AI та організацією</p>
        </div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab-trigger${tab === 'integrations' ? ' active' : ''}`}
          onClick={() => selectTab('integrations')}
        >
          <IconPlug size={15} />
          Інтеграції
        </button>
        <button type="button" className={`tab-trigger${tab === 'ai' ? ' active' : ''}`} onClick={() => selectTab('ai')}>
          <IconSparkles size={15} />
          AI
        </button>
        <button
          type="button"
          className={`tab-trigger${tab === 'organization' ? ' active' : ''}`}
          onClick={() => selectTab('organization')}
        >
          <IconBuilding size={15} />
          Організація
        </button>
      </div>

      {tab === 'integrations' && (
        <div className="integrations-grid">
          <IntegrationsPanel />
          <WhatsAppPanel />
        </div>
      )}
      {tab === 'ai' && <AiPanel />}
      {tab === 'organization' && <OrganizationPanel />}
    </div>
  )
}

interface CheckResult {
  ok: boolean
  botUsername?: string
  webhookUrl?: string
  pendingUpdateCount?: number
  error?: string
}

function IntegrationsPanel() {
  const { session } = useAuth()
  const [botToken, setBotToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectedUsername, setConnectedUsername] = useState<string | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    if (!session) return

    supabase
      .from('channel_credentials')
      .select('created_at')
      .eq('channel_type', 'telegram')
      .maybeSingle()
      .then(({ data }) => {
        setConnectedUsername(data ? 'connected' : null)
        setCheckingStatus(false)
      })
  }, [session])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token

    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSubmitting(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/connect-telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ botToken }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося підключити бота')
      } else {
        setConnectedUsername(data.botUsername || 'connected')
        setBotToken('')
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSubmitting(false)
    }
  }

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  }

  async function handleCheck() {
    setChecking(true)
    setCheckResult(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setCheckResult({ ok: false, error: 'Сесія недійсна, увійдіть знову' })
      setChecking(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/check-telegram-connection', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()
      setCheckResult(res.ok ? data : { ok: false, error: data.error ?? 'Не вдалося перевірити зв’язок' })
    } catch {
      setCheckResult({ ok: false, error: 'Мережева помилка' })
    } finally {
      setChecking(false)
    }
  }

  async function handleDisconnect() {
    if (!window.confirm('Відключити Telegram-бота? Webhook і збережені дані підключення буде видалено.')) {
      return
    }

    setDisconnecting(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDisconnecting(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/disconnect-telegram', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося відключити бота')
      } else {
        setConnectedUsername(null)
        setCheckResult(null)
      }
    } catch {
      setError('Мережева помилка')
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <h3 style={{ fontSize: '1.0625rem', marginBottom: '0.375rem' }}>Telegram</h3>
          <p style={{ color: 'var(--fg-muted)', fontSize: '0.875rem' }}>
            Підключіть бота, щоб отримувати та обробляти ліди з Telegram.
          </p>
        </div>

        {!checkingStatus && connectedUsername && (
          <>
            <div className="alert alert-info">
              <IconCheckCircle size={16} />
              <span>Telegram-бот вже підключено{connectedUsername !== 'connected' ? `: @${connectedUsername}` : ''}</span>
            </div>

            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <button type="button" className="btn btn-secondary" onClick={handleCheck} disabled={checking}>
                {checking ? <IconSpinner size={16} /> : 'Перевірити зв’язок'}
              </button>
              <button type="button" className="btn btn-danger-ghost" onClick={handleDisconnect} disabled={disconnecting}>
                {disconnecting ? <IconSpinner size={16} /> : 'Відключити'}
              </button>
            </div>

            {checkResult &&
              (checkResult.ok ? (
                <div className="alert alert-info">
                  <IconCheckCircle size={16} />
                  <span>
                    @{checkResult.botUsername || '—'} активний · webhook: {checkResult.webhookUrl || '—'} · в черзі:{' '}
                    {checkResult.pendingUpdateCount ?? 0}
                  </span>
                </div>
              ) : (
                <div className="alert alert-error">
                  <IconAlert size={16} />
                  <span>{checkResult.error}</span>
                </div>
              ))}
          </>
        )}

        <form className="auth-form" onSubmit={handleSubmit} autoComplete="off">
          <div className="field">
            <label htmlFor="settings-telegram-bot-token">Telegram Bot Token</label>
            <input
              id="settings-telegram-bot-token"
              className="input"
              type="text"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456789:AA..."
              required
            />
          </div>

          {error && (
            <div className="alert alert-error">
              <IconAlert size={16} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={submitting} style={{ alignSelf: 'flex-start' }}>
            {submitting ? <IconSpinner size={16} /> : 'Підключити'}
          </button>
        </form>
      </div>
    </div>
  )
}

interface WhatsAppStatus {
  ok: boolean
  displayNumber?: string
  verifiedName?: string
  qualityRating?: string
  wabaId?: string | null
  webhookUrl?: string
  error?: string
}

// Same shape as the Telegram card, with the one difference the channel
// forces: Meta's webhook callback URL and verify token can't be registered
// through the API, so they're shown for the operator to paste into the app.
function WhatsAppPanel() {
  const { session } = useAuth()
  const [accessToken, setAccessToken] = useState('')
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [connected, setConnected] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<WhatsAppStatus | null>(null)
  const [webhookHint, setWebhookHint] = useState<{ url: string; verifyToken: string } | null>(null)

  useEffect(() => {
    if (!session) return

    supabase
      .from('channel_credentials')
      .select('created_at')
      .eq('channel_type', 'whatsapp')
      .maybeSingle()
      .then(({ data }) => {
        setConnected(Boolean(data))
        setCheckingStatus(false)
      })
  }, [session])

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const sessionToken = await getAccessToken()
    if (!sessionToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSubmitting(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/whatsapp-connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ accessToken, phoneNumberId, appSecret }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося підключити WhatsApp')
      } else {
        setConnected(true)
        setAccessToken('')
        setAppSecret('')
        setWebhookHint({ url: data.webhookUrl, verifyToken: data.verifyToken })
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCheck() {
    setChecking(true)
    setStatus(null)

    const sessionToken = await getAccessToken()
    if (!sessionToken) {
      setStatus({ ok: false, error: 'Сесія недійсна, увійдіть знову' })
      setChecking(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/check-whatsapp-connection', {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}` },
      })
      const data = await res.json()
      setStatus(res.ok ? data : { ok: false, error: data.error ?? 'Не вдалося перевірити зв’язок' })
    } catch {
      setStatus({ ok: false, error: 'Мережева помилка' })
    } finally {
      setChecking(false)
    }
  }

  async function handleDisconnect() {
    if (!window.confirm('Відключити WhatsApp? Підписку на webhook і збережені дані підключення буде видалено.')) {
      return
    }

    setDisconnecting(true)
    setError(null)

    const sessionToken = await getAccessToken()
    if (!sessionToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDisconnecting(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/disconnect-whatsapp', {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}` },
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося відключити WhatsApp')
      } else {
        setConnected(false)
        setStatus(null)
        setWebhookHint(null)
      }
    } catch {
      setError('Мережева помилка')
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <h3 style={{ fontSize: '1.0625rem', marginBottom: '0.375rem' }}>WhatsApp</h3>
          <p style={{ color: 'var(--fg-muted)', fontSize: '0.875rem' }}>
            Підключіть номер WhatsApp Cloud API, щоб вести листування й тунелі в WhatsApp.
          </p>
        </div>

        {!checkingStatus && connected && (
          <>
            <div className="alert alert-info">
              <IconCheckCircle size={16} />
              <span>WhatsApp підключено</span>
            </div>

            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <button type="button" className="btn btn-secondary" onClick={handleCheck} disabled={checking}>
                {checking ? <IconSpinner size={16} /> : 'Перевірити зв’язок'}
              </button>
              <button type="button" className="btn btn-danger-ghost" onClick={handleDisconnect} disabled={disconnecting}>
                {disconnecting ? <IconSpinner size={16} /> : 'Відключити'}
              </button>
            </div>

            {status &&
              (status.ok ? (
                <div className="alert alert-info">
                  <IconCheckCircle size={16} />
                  <span>
                    {status.displayNumber || '—'} · {status.verifiedName || 'без назви'} · якість:{' '}
                    {status.qualityRating || '—'}
                  </span>
                </div>
              ) : (
                <div className="alert alert-error">
                  <IconAlert size={16} />
                  <span>{status.error}</span>
                </div>
              ))}
          </>
        )}

        {/* Meta doesn't accept a callback URL over the API the way Telegram's
            setWebhook does — it's configured once on the app itself. */}
        {webhookHint && (
          <div className="alert alert-info" style={{ alignItems: 'flex-start' }}>
            <IconAlert size={16} />
            <span style={{ overflowWrap: 'anywhere' }}>
              Вкажіть у налаштуваннях Meta-застосунку (WhatsApp → Configuration):
              <br />
              Callback URL: <code>{webhookHint.url}</code>
              <br />
              Verify token: <code>{webhookHint.verifyToken}</code>
              <br />
              Токен показується один раз — збережіть його зараз.
            </span>
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit} autoComplete="off">
          <div className="field">
            <label htmlFor="settings-wa-access-token">Permanent access token</label>
            <input
              id="settings-wa-access-token"
              className="input input-masked"
              type="text"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="EAAG..."
              required
            />
          </div>

          <div className="field">
            <label htmlFor="settings-wa-phone-id">Phone Number ID</label>
            <input
              id="settings-wa-phone-id"
              className="input"
              type="text"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder="1234567890"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="settings-wa-app-secret">App Secret</label>
            <input
              id="settings-wa-app-secret"
              className="input input-masked"
              type="text"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="з налаштувань Meta-застосунку"
              required
            />
            <p className="settings-row-hint">Потрібен, щоб перевіряти підпис вхідних webhook-запитів від Meta.</p>
          </div>

          {error && (
            <div className="alert alert-error">
              <IconAlert size={16} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={submitting} style={{ alignSelf: 'flex-start' }}>
            {submitting ? <IconSpinner size={16} /> : 'Підключити'}
          </button>
        </form>
      </div>
    </div>
  )
}

// OpenRouter is the only provider, so this is a single connection block
// rather than a card per provider.
function AiPanel() {
  const { session } = useAuth()
  const [apiKey, setApiKey] = useState('')
  const [connected, setConnected] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return

    supabase
      .from('ai_credentials')
      .select('created_at')
      .maybeSingle()
      .then(({ data }) => {
        setConnected(!!data)
        setCheckingStatus(false)
      })
  }, [session])

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSubmitting(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/connect-ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ apiKey }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося підключити ключ')
      } else {
        setConnected(true)
        setApiKey('')
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDisconnect() {
    if (!window.confirm('Відключити OpenRouter? Збережений ключ буде видалено, а AI-вузли перестануть відповідати.')) return

    setDisconnecting(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDisconnecting(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/disconnect-ai', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося відключити AI')
      } else {
        setConnected(false)
      }
    } catch {
      setError('Мережева помилка')
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <h3 style={{ fontSize: '1.0625rem', marginBottom: '0.375rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <IconSparkles size={17} style={{ color: 'var(--ai)' }} />
            OpenRouter
          </h3>
          <p style={{ color: 'var(--fg-muted)', fontSize: '0.875rem' }}>
            Один ключ до сотень моделей. Зберігається зашифрованим у Vault і ніколи не повертається у браузер —
            AI-вузли у воронках беруть модель зі свого налаштування.
          </p>
        </div>

        {!checkingStatus && connected && (
          <>
            <div className="alert alert-info">
              <IconCheckCircle size={16} />
              <span>OpenRouter вже підключено</span>
            </div>

            <button
              type="button"
              className="btn btn-danger-ghost"
              onClick={handleDisconnect}
              disabled={disconnecting}
              style={{ alignSelf: 'flex-start' }}
            >
              {disconnecting ? <IconSpinner size={16} /> : 'Відключити'}
            </button>
          </>
        )}

        <form className="auth-form" onSubmit={handleSubmit} autoComplete="off">
          <div className="field">
            <label htmlFor="settings-openrouter-api-key">OpenRouter API ключ</label>
            <input
              id="settings-openrouter-api-key"
              className="input input-masked"
              type="text"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-or-..."
              required
            />
          </div>

          {error && (
            <div className="alert alert-error">
              <IconAlert size={16} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={submitting} style={{ alignSelf: 'flex-start' }}>
            {submitting ? <IconSpinner size={16} /> : connected ? 'Замінити ключ' : 'Підключити'}
          </button>
        </form>
      </div>
    </div>
  )
}

function OrganizationPanel() {
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Назва організації</div>
            <div className="settings-row-hint">Використовується у звітах та повідомленнях</div>
          </div>
          <span className="badge badge-neutral">Незабаром</span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Учасники команди</div>
            <div className="settings-row-hint">Запрошуйте колег до організації</div>
          </div>
          <span className="badge badge-neutral">Незабаром</span>
        </div>
      </div>
    </div>
  )
}
