import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { IconAlert, IconBolt, IconBraces, IconCheckCircle, IconEdit, IconPlus, IconSpinner, IconSync, IconTag, IconTrash } from '../components/icons'

type Tab = 'tags' | 'variables' | 'templates' | 'quick-replies'

const TABS: Tab[] = ['tags', 'variables', 'templates', 'quick-replies']

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export default function Elements() {
  // Tab in the URL, like Settings — that's what lets the retired
  // /dashboard/templates route redirect straight onto the right tab.
  const [searchParams, setSearchParams] = useSearchParams()
  const paramTab = searchParams.get('tab') as Tab | null
  const tab: Tab = paramTab && TABS.includes(paramTab) ? paramTab : 'tags'

  function setTab(next: Tab) {
    setSearchParams(next === 'tags' ? {} : { tab: next }, { replace: true })
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Елементи</h1>
          <p className="page-description">Каталог тегів і змінних для дій у воронках</p>
        </div>
      </div>

      <div className="tabs">
        <button type="button" className={`tab-trigger${tab === 'tags' ? ' active' : ''}`} onClick={() => setTab('tags')}>
          <IconTag size={15} />
          Теги
        </button>
        <button
          type="button"
          className={`tab-trigger${tab === 'variables' ? ' active' : ''}`}
          onClick={() => setTab('variables')}
        >
          <IconBraces size={15} />
          Змінні
        </button>
        <button
          type="button"
          className={`tab-trigger${tab === 'templates' ? ' active' : ''}`}
          onClick={() => setTab('templates')}
        >
          <IconCheckCircle size={15} />
          Шаблони
        </button>
        <button
          type="button"
          className={`tab-trigger${tab === 'quick-replies' ? ' active' : ''}`}
          onClick={() => setTab('quick-replies')}
        >
          <IconBolt size={15} />
          Швидкі відповіді
        </button>
      </div>

      {tab === 'tags' && <TagsPanel />}
      {tab === 'variables' && <VariablesPanel />}
      {tab === 'templates' && <TemplatesPanel />}
      {tab === 'quick-replies' && <QuickRepliesPanel />}
    </div>
  )
}

interface TagRow {
  id: string
  name: string
}

function TagsPanel() {
  const [tags, setTags] = useState<TagRow[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function load() {
    supabase
      .from('tags')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        setTags((data ?? []) as TagRow[])
        setLoading(false)
      })
  }

  useEffect(load, [])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setCreating(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-tag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося створити тег')
      } else {
        setName('')
        load()
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Видалити тег? Його буде знято з усіх лідів.')) return
    setDeletingId(id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDeletingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-tag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id, delete: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося видалити тег')
      } else {
        setTags((prev) => prev.filter((t) => t.id !== id))
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 560 }}>
      <form className="card" onSubmit={handleCreate} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="tag-name">Назва тегу</label>
          <input
            id="tag-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="напр. гарячий_лід"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={creating || !name.trim()}>
          {creating ? <IconSpinner size={16} /> : <IconPlus size={16} />}
          Створити
        </button>
      </form>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : tags.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">
            <IconTag size={22} />
          </span>
          <h3>Ще немає тегів</h3>
          <p>Створіть перший тег вище — він одразу стане доступним у діях воронок.</p>
        </div>
      ) : (
        <div className="funnel-list">
          {tags.map((tag) => (
            <div className="card funnel-row" key={tag.id}>
              <div className="funnel-row-info">
                <span className="funnel-row-name">{tag.name}</span>
              </div>
              <div className="funnel-row-actions">
                <button
                  type="button"
                  className="btn-icon-ghost"
                  disabled={deletingId === tag.id}
                  onClick={() => handleDelete(tag.id)}
                  aria-label="Видалити тег"
                >
                  {deletingId === tag.id ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface VariableDefRow {
  id: string
  key: string
  label: string
}

function VariablesPanel() {
  const [variables, setVariables] = useState<VariableDefRow[]>([])
  const [loading, setLoading] = useState(true)
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function load() {
    supabase
      .from('variable_defs')
      .select('id, key, label')
      .order('key')
      .then(({ data }) => {
        setVariables((data ?? []) as VariableDefRow[])
        setLoading(false)
      })
  }

  useEffect(load, [])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!key.trim() || !label.trim()) return
    setCreating(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setCreating(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-variable-def', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ key: key.trim(), label: label.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося створити змінну')
      } else {
        setKey('')
        setLabel('')
        load()
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Видалити змінну? Її значення буде втрачено для всіх лідів.')) return
    setDeletingId(id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDeletingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-variable-def', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id, delete: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося видалити змінну')
      } else {
        setVariables((prev) => prev.filter((v) => v.id !== id))
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 560 }}>
      <form className="card" onSubmit={handleCreate} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor="var-key">Ключ</label>
          <input id="var-key" className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="напр. utm_source" />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor="var-label">Назва</label>
          <input
            id="var-label"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="напр. Джерело трафіку"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={creating || !key.trim() || !label.trim()}>
          {creating ? <IconSpinner size={16} /> : <IconPlus size={16} />}
          Створити
        </button>
      </form>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : variables.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">
            <IconBraces size={22} />
          </span>
          <h3>Ще немає змінних</h3>
          <p>Створіть першу змінну вище — вона одразу стане доступною у діях воронок.</p>
        </div>
      ) : (
        <div className="funnel-list">
          {variables.map((v) => (
            <div className="card funnel-row" key={v.id}>
              <div className="funnel-row-info">
                <span className="funnel-row-name">{v.label}</span>
                <span className="funnel-row-meta">{v.key}</span>
              </div>
              <div className="funnel-row-actions">
                <button
                  type="button"
                  className="btn-icon-ghost"
                  disabled={deletingId === v.id}
                  onClick={() => handleDelete(v.id)}
                  aria-label="Видалити змінну"
                >
                  {deletingId === v.id ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- WhatsApp message templates (moved here from its own page;
// logic unchanged, only the shell it renders in) ----------

interface TemplateRow {
  id: string
  name: string
  language: string
  category: string
  body: string
  status: string
  rejection_reason: string | null
  created_at: string
}

const CATEGORIES = [
  { value: 'MARKETING', label: 'Маркетинг' },
  { value: 'UTILITY', label: 'Службовий' },
  { value: 'AUTHENTICATION', label: 'Автентифікація' },
]

const LANGUAGES = [
  { value: 'uk', label: 'Українська' },
  { value: 'en_US', label: 'English (US)' },
  { value: 'ru', label: 'Русский' },
  { value: 'es', label: 'Español' },
]

// Meta's own status vocabulary, mapped onto the app's badge colours.
function statusClass(status: string): string {
  if (status === 'APPROVED') return 'badge badge-success'
  if (status === 'REJECTED' || status === 'DISABLED') return 'badge badge-danger'
  return 'badge badge-warning'
}

function statusLabel(status: string): string {
  if (status === 'APPROVED') return 'Затверджено'
  if (status === 'REJECTED') return 'Відхилено'
  if (status === 'PENDING') return 'На модерації'
  return status
}

function TemplatesPanel() {
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [language, setLanguage] = useState('uk')
  const [category, setCategory] = useState('MARKETING')
  const [body, setBody] = useState('')

  async function loadTemplates() {
    const { data, error: loadError } = await supabase
      .from('message_templates')
      .select('id, name, language, category, body, status, rejection_reason, created_at')
      .order('created_at', { ascending: false })

    if (loadError) setError(loadError.message)
    else setTemplates((data ?? []) as TemplateRow[])
    setLoading(false)
  }

  useEffect(() => {
    void loadTemplates()
  }, [])

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
      const res = await fetch('/.netlify/functions/save-message-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action: 'create', name, language, category, body }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося створити шаблон')
      } else {
        setTemplates((prev) => [data.template as TemplateRow, ...prev])
        setName('')
        setBody('')
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSubmitting(false)
    }
  }

  // Meta doesn't call back when a template is approved or rejected, so the
  // status is pulled on demand instead of being trusted from submission time.
  async function handleRefresh() {
    setError(null)
    setRefreshing(true)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setRefreshing(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-message-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action: 'refresh' }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Не вдалося оновити статуси')
      else await loadTemplates()
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleDelete(template: TemplateRow) {
    if (!window.confirm(`Прибрати шаблон «${template.name}» зі списку?`)) return

    setDeletingId(template.id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDeletingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-message-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action: 'delete', templateId: template.id }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Не вдалося видалити шаблон')
      else setTemplates((prev) => prev.filter((t) => t.id !== template.id))
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <p className="page-description" style={{ marginBottom: '1rem' }}>
        WhatsApp дозволяє писати вільним текстом лише 24 години після повідомлення ліда. Далі — тільки затверджений
        шаблон.
      </p>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="card card-tight">
        <div className="analytics-section-header analytics-ad-spend-header">
          <IconCheckCircle size={16} aria-hidden="true" />
          <h3>Шаблони</h3>
          <button type="button" className="btn btn-secondary analytics-upload-btn" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? <IconSpinner size={15} /> : <IconSync size={15} />}
            Оновити статуси
          </button>
        </div>

        {loading ? (
          <p className="settings-row-hint" style={{ padding: '0 1rem 1rem' }}>
            Завантаження…
          </p>
        ) : templates.length === 0 ? (
          <div className="empty-state" style={{ border: 'none', background: 'transparent' }}>
            <h3>Ще немає шаблонів</h3>
            <p>Додайте перший шаблон нижче — він піде на модерацію в Meta.</p>
          </div>
        ) : (
          <ul className="template-list">
            {templates.map((t) => (
              <li key={t.id} className="template-item">
                <div className="template-item-main">
                  <span className="template-item-head">
                    <span className="template-item-name">{t.name}</span>
                    <span className={statusClass(t.status)}>{statusLabel(t.status)}</span>
                  </span>
                  <span className="template-item-meta">
                    {t.language} · {CATEGORIES.find((c) => c.value === t.category)?.label ?? t.category}
                  </span>
                  <span className="template-item-body">{t.body}</span>
                  {t.rejection_reason && (
                    <span className="template-item-reason">Причина відмови: {t.rejection_reason}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost import-item-delete"
                  onClick={() => void handleDelete(t)}
                  disabled={deletingId === t.id}
                  aria-label={`Видалити шаблон ${t.name}`}
                >
                  {deletingId === t.id ? <IconSpinner size={13} /> : 'Видалити'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card" style={{ maxWidth: 560 }}>
        <h3 style={{ fontSize: '1.0625rem', marginBottom: '0.875rem' }}>Новий шаблон</h3>
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="tplName">Назва</label>
            <input
              id="tplName"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="order_confirmation"
              required
            />
            <p className="settings-row-hint">Лише малі латинські літери, цифри та _ — вимога Meta.</p>
          </div>

          <div className="field">
            <label htmlFor="tplLang">Мова</label>
            <select id="tplLang" className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="tplCategory">Категорія</label>
            <select id="tplCategory" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="tplBody">Текст</label>
            <textarea
              id="tplBody"
              className="input"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Вітаємо! Ваше замовлення прийнято."
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={submitting} style={{ alignSelf: 'flex-start' }}>
            {submitting ? <IconSpinner size={16} /> : 'Відправити на затвердження'}
          </button>
        </form>
      </div>
    </>
  )
}

// ---------- Quick replies — canned answers a manager inserts into the chat
// reply field from Chats.tsx (see QuickReplyPicker there), not sent
// automatically. org-wide catalog, same shape as tags/variables. ----------

export interface QuickReplyRow {
  id: string
  title: string
  text: string
  created_at: string
}

function QuickRepliesPanel() {
  const [replies, setReplies] = useState<QuickReplyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  // Set while editing an existing reply — the same form doubles as the
  // create form when this is null, matching the pattern the entry point
  // needed here (edit) but tags/variables above don't.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function load() {
    supabase
      .from('quick_replies')
      .select('id, title, text, created_at')
      .order('title')
      .then(({ data }) => {
        setReplies((data ?? []) as QuickReplyRow[])
        setLoading(false)
      })
  }

  useEffect(load, [])

  function startEdit(reply: QuickReplyRow) {
    setEditingId(reply.id)
    setTitle(reply.title)
    setText(reply.text)
    setError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setTitle('')
    setText('')
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || !text.trim()) return
    setSaving(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSaving(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-quick-reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id: editingId ?? undefined, title: title.trim(), text: text.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося зберегти швидку відповідь')
      } else {
        const saved = data.reply as QuickReplyRow
        setReplies((prev) => (editingId ? prev.map((r) => (r.id === saved.id ? saved : r)) : [...prev, saved].sort((a, b) => a.title.localeCompare(b.title))))
        cancelEdit()
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Видалити швидку відповідь?')) return
    setDeletingId(id)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setDeletingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-quick-reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id, delete: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося видалити швидку відповідь')
      } else {
        setReplies((prev) => prev.filter((r) => r.id !== id))
        if (editingId === id) cancelEdit()
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 560 }}>
      <form className="card" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div className="field">
          <label htmlFor="qr-title">Назва</label>
          <input
            id="qr-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="напр. Вітання"
          />
        </div>
        <div className="field">
          <label htmlFor="qr-text">Текст</label>
          <textarea
            id="qr-text"
            className="input"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Текст, який вставиться в поле вводу…"
          />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="submit" className="btn btn-primary" disabled={saving || !title.trim() || !text.trim()}>
            {saving ? <IconSpinner size={16} /> : editingId ? <IconCheckCircle size={16} /> : <IconPlus size={16} />}
            {editingId ? 'Зберегти' : 'Створити'}
          </button>
          {editingId && (
            <button type="button" className="btn btn-ghost" onClick={cancelEdit} disabled={saving}>
              Скасувати
            </button>
          )}
        </div>
      </form>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : replies.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">
            <IconBolt size={22} />
          </span>
          <h3>Ще немає швидких відповідей</h3>
          <p>Створіть першу вище — вона одразу стане доступною в чаті поряд з полем вводу.</p>
        </div>
      ) : (
        <div className="funnel-list">
          {replies.map((reply) => (
            <div className="card funnel-row" key={reply.id}>
              <div className="funnel-row-info">
                <span className="funnel-row-name">{reply.title}</span>
                <span className="funnel-row-meta" style={{ whiteSpace: 'normal' }}>
                  {reply.text}
                </span>
              </div>
              <div className="funnel-row-actions">
                <button
                  type="button"
                  className="btn-icon-ghost"
                  onClick={() => startEdit(reply)}
                  aria-label={`Редагувати «${reply.title}»`}
                >
                  <IconEdit size={14} />
                </button>
                <button
                  type="button"
                  className="btn-icon-ghost"
                  disabled={deletingId === reply.id}
                  onClick={() => void handleDelete(reply.id)}
                  aria-label={`Видалити «${reply.title}»`}
                >
                  {deletingId === reply.id ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
