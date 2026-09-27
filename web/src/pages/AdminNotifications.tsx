import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { adminOrgsApi, type AdminOrgListItem } from '../lib/adminOrgs'
import { IconAlert, IconCheckCircle, IconSend, IconSpinner } from '../components/icons'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

// Platform admin → organizations: a message that lands under each target
// org's sidebar bell (admin-broadcast.ts writes one notifications row per org).
export default function AdminNotifications() {
  const [orgs, setOrgs] = useState<AdminOrgListItem[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [target, setTarget] = useState<'all' | string>('all')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<number | null>(null)

  useEffect(() => {
    adminOrgsApi<{ organizations: AdminOrgListItem[] }>({ action: 'list' })
      .then((data) => setOrgs(data.organizations))
      .catch(() => setOrgs([]))
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    const targetLabel = target === 'all' ? `усім організаціям (${orgs.length})` : `«${orgs.find((o) => o.id === target)?.name ?? 'організації'}»`
    if (!window.confirm(`Надіслати сповіщення ${targetLabel}?`)) return
    setSending(true)
    setError(null)
    setSent(null)
    const token = await getAccessToken()
    if (!token) {
      setError('Сесія недійсна, увійдіть знову')
      setSending(false)
      return
    }
    try {
      const res = await fetch('/.netlify/functions/admin-broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), linkUrl: linkUrl.trim() || null, orgId: target === 'all' ? null : target }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Не вдалося надіслати')
      else {
        setSent(data.sent ?? 0)
        setTitle('')
        setBody('')
        setLinkUrl('')
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Сповіщення</h1>
          <p className="page-description">Повідомлення організаціям — з’являється під дзвіночком у їхньому сайдбарі</p>
        </div>
      </div>

      <form className="card auth-form" style={{ maxWidth: 560 }} onSubmit={handleSubmit} autoComplete="off">
        <div className="field">
          <label htmlFor="bc-target">Кому</label>
          <select id="bc-target" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="all">Усім організаціям{orgs.length ? ` (${orgs.length})` : ''}</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.owner_email ? ` — ${o.owner_email}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bc-title">Заголовок</label>
          <input id="bc-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="напр. Оновлення: нові шаблони лендінгів" />
        </div>
        <div className="field">
          <label htmlFor="bc-body">Текст</label>
          <textarea id="bc-body" className="input textarea" rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} />
        </div>
        <div className="field">
          <label htmlFor="bc-link">Посилання (опційно)</label>
          <input id="bc-link" className="input" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="/dashboard/settings або https://…" />
          <p className="settings-row-hint" style={{ margin: '0.25rem 0 0' }}>
            Клік по сповіщенню відкриє його: шлях у застосунку — на місці, зовнішнє посилання — у новій вкладці.
          </p>
        </div>

        {error && (
          <div className="alert alert-error">
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}
        {sent !== null && !error && (
          <div className="alert alert-info">
            <IconCheckCircle size={16} />
            <span>Надіслано: {sent} {sent === 1 ? 'організації' : 'організаціям'}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={sending || !title.trim()} style={{ alignSelf: 'flex-start' }}>
          {sending ? <IconSpinner size={16} /> : <IconSend size={16} />}
          Надіслати
        </button>
      </form>
    </div>
  )
}
