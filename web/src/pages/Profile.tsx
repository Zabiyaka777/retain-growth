import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { IconAlert, IconBell, IconCheckCircle, IconCreditCard, IconMail, IconSpinner, IconUser } from '../components/icons'
import { disablePushNotifications, enablePushNotifications, isPushEnabled, isPushSupported } from '../lib/pushNotifications'
import BillingPanel from '../components/BillingPanel'

type Tab = 'account' | 'billing'
const TABS: Tab[] = ['account', 'billing']

export default function Profile() {
  const [searchParams, setSearchParams] = useSearchParams()
  const paramTab = searchParams.get('tab') as Tab | null
  const tab: Tab = paramTab && TABS.includes(paramTab) ? paramTab : 'account'

  function selectTab(next: Tab) {
    setSearchParams(next === 'account' ? {} : { tab: next }, { replace: true })
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Профіль</h1>
          <p className="page-description">Дані вашого акаунта та тарифікація</p>
        </div>
      </div>

      <div className="tabs">
        <button type="button" className={`tab-trigger${tab === 'account' ? ' active' : ''}`} onClick={() => selectTab('account')}>
          <IconUser size={15} />
          Профіль
        </button>
        <button type="button" className={`tab-trigger${tab === 'billing' ? ' active' : ''}`} onClick={() => selectTab('billing')}>
          <IconCreditCard size={15} />
          Тарифікація
        </button>
      </div>

      {tab === 'account' && <AccountPanel />}
      {tab === 'billing' && <BillingPanel />}
    </div>
  )
}

function AccountPanel() {
  const { session } = useAuth()
  const email = session?.user.email ?? ''
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)

  useEffect(() => {
    if (!isPushSupported()) return
    isPushEnabled().then(setPushEnabled)
  }, [])

  async function togglePush() {
    setPushBusy(true)
    setPushError(null)
    try {
      if (pushEnabled) {
        await disablePushNotifications()
        setPushEnabled(false)
      } else {
        await enablePushNotifications()
        setPushEnabled(true)
      }
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Не вдалося змінити налаштування сповіщень')
    } finally {
      setPushBusy(false)
    }
  }

  async function handleChangePassword() {
    if (!email) return
    setSending(true)
    setError(null)
    setInfo(null)

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email)

    if (resetError) {
      setError(resetError.message)
    } else {
      setInfo('Лист для зміни пароля надіслано на вашу пошту.')
    }
    setSending(false)
  }

  return (
    <div className="card" style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <span className="sidebar-avatar" style={{ width: 48, height: 48, fontSize: '1rem' }}>
            <IconUser size={20} />
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>{email}</div>
            <div className="settings-row-hint">Обліковий запис</div>
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row-label">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                <IconMail size={15} />
                Email
              </span>
            </div>
            <div className="settings-row-hint">{email}</div>
          </div>
        </div>

        {isPushSupported() && (
          <div className="settings-row">
            <div>
              <div className="settings-row-label">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <IconBell size={15} />
                  Push-сповіщення
                </span>
              </div>
              <div className="settings-row-hint">
                Системне сповіщення про нові повідомлення від лідів, навіть коли вкладка закрита.
              </div>
            </div>
            <button
              type="button"
              className={`toggle ${pushEnabled ? 'on' : ''}`}
              onClick={togglePush}
              disabled={pushBusy}
              aria-pressed={pushEnabled}
              aria-label="Увімкнути сповіщення"
            >
              <span className="toggle-knob" />
            </button>
          </div>
        )}
        {pushError && (
          <div className="alert alert-error">
            <IconAlert size={16} />
            <span>{pushError}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <button type="button" className="btn btn-secondary" onClick={handleChangePassword} disabled={sending} style={{ alignSelf: 'flex-start' }}>
            {sending ? <IconSpinner size={16} /> : 'Змінити пароль'}
          </button>

          {error && (
            <div className="alert alert-error">
              <IconAlert size={16} />
              <span>{error}</span>
            </div>
          )}
          {info && (
            <div className="alert alert-info">
              <IconCheckCircle size={16} />
              <span>{info}</span>
            </div>
          )}
        </div>
      </div>
    )
}
