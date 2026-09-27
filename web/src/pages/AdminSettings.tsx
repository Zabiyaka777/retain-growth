import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { IconAlert, IconCheckCircle, IconSpinner } from '../components/icons'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

// Platform-level settings — currently just the one credential custom landing
// domains depend on (save-landing-domain.ts / check-landing-domain.ts). Not
// per-org, so it lives here rather than in any tenant's own Settings page.
export default function AdminSettings() {
  const { session } = useAuth()
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!session) return
    supabase
      .from('platform_settings')
      .select('key')
      .eq('key', 'netlify_api_token')
      .maybeSingle()
      .then(({ data }) => {
        setHasToken(!!data)
        setLoading(false)
      })
  }, [session])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!token.trim()) return
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
      const res = await fetch('/.netlify/functions/save-platform-setting', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ key: 'netlify_api_token', value: token.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося зберегти')
      } else {
        setHasToken(true)
        setToken('')
        setSaved(true)
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Налаштування платформи</h1>
          <p className="page-description">Керує можливостями, спільними для всіх організацій</p>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 480 }}>
        <div className="settings-row-label">Netlify API токен</div>
        <p className="settings-row-hint" style={{ margin: '0.25rem 0 1rem' }}>
          Personal Access Token з вашого акаунта Netlify (User settings → Applications → New access token). Потрібен,
          щоб додавати власні домени лендінгів як domain alias цього сайту та перевіряти статус DNS/SSL. Токен дає
          повний доступ до вашого акаунта Netlify — тримайте його лише тут, у Vault.
        </p>

        {loading ? (
          <p className="settings-row-hint">Завантаження…</p>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit} autoComplete="off">
            {hasToken && (
              <div className="alert alert-info">
                <IconCheckCircle size={16} />
                <span>Токен збережено</span>
              </div>
            )}
            <div className="field">
              <label htmlFor="admin-netlify-token">{hasToken ? 'Замінити токен' : 'Токен'}</label>
              <input
                id="admin-netlify-token"
                className="input input-masked"
                type="text"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={hasToken ? 'Збережено — введіть новий, щоб замінити' : 'nfp_…'}
              />
            </div>

            {error && (
              <div className="alert alert-error">
                <IconAlert size={16} />
                <span>{error}</span>
              </div>
            )}
            {saved && !error && (
              <div className="alert alert-info">
                <IconCheckCircle size={16} />
                <span>Збережено</span>
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={saving || !token.trim()} style={{ alignSelf: 'flex-start' }}>
              {saving ? <IconSpinner size={16} /> : hasToken ? 'Замінити' : 'Зберегти'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
