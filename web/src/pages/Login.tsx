import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { IconAlert, IconCheckCircle, IconLock, IconMail, IconSpinner } from '../components/icons'

export default function Login() {
  const { session, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!loading && session) {
    return <Navigate to="/dashboard" replace />
  }

  async function handleSignIn(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setInfo(null)
    setSubmitting(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    if (signInError) {
      setError(signInError.message)
    }
    setSubmitting(false)
  }

  async function handleSignUp() {
    setError(null)
    setInfo(null)

    if (!email || !password) {
      setError('Введіть email і пароль')
      return
    }

    setSubmitting(true)
    const { data, error: signUpError } = await supabase.auth.signUp({ email, password })

    if (signUpError) {
      setError(signUpError.message)
    } else if (!data.session) {
      setInfo('Реєстрація успішна. Перевірте пошту, щоб підтвердити акаунт.')
    }
    setSubmitting(false)
  }

  return (
    <div className="auth-shell">
      <div className="auth-card fade-in">
        <div className="auth-brand">
          <span className="auth-mark">RG</span>
          <div>
            <h1 style={{ fontSize: '1.25rem' }}>Retain Growth</h1>
            <p className="auth-subtitle">Увійдіть, щоб продовжити роботу</p>
          </div>
        </div>

        <form className="auth-form" onSubmit={handleSignIn}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <div className="input-wrap">
              <span className="input-icon">
                <IconMail size={16} />
              </span>
              <input
                id="email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoComplete="email"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="password">Пароль</label>
            <div className="input-wrap">
              <span className="input-icon">
                <IconLock size={16} />
              </span>
              <input
                id="password"
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
          </div>

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

          <div className="auth-actions">
            <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
              {submitting ? <IconSpinner size={16} /> : 'Увійти'}
            </button>
            <div className="auth-divider">або</div>
            <button type="button" className="btn btn-secondary btn-block" disabled={submitting} onClick={handleSignUp}>
              Зареєструватись
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
