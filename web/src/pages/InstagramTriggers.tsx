import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { IconAlert, IconInstagram, IconPlus, IconSpinner, IconTrash } from '../components/icons'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

async function saveTrigger(body: Record<string, unknown>) {
  const token = await getAccessToken()
  if (!token) throw new Error('Сесія недійсна, увійдіть знову')
  const res = await fetch('/.netlify/functions/save-instagram-trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Не вдалося зберегти тригер')
  return json
}

interface FunnelOption {
  id: string
  name: string
}

interface MessageNodeOption {
  id: string
  label: string
  hasButton: boolean
}

// Same cascading funnel -> node picker LeadGenLinkForm.tsx uses for its
// entry-node select, filtered to 'message' nodes instead of 'entry' ones —
// this is the node whose Instagram tab text + buttons become the DM.
function FunnelNodePicker({
  funnelId,
  nodeId,
  onFunnelChange,
  onNodeChange,
  warnOnMissingButton,
}: {
  funnelId: string
  nodeId: string
  onFunnelChange: (id: string) => void
  onNodeChange: (id: string) => void
  warnOnMissingButton: boolean
}) {
  const [funnels, setFunnels] = useState<FunnelOption[]>([])
  const [nodes, setNodes] = useState<MessageNodeOption[]>([])
  const [nodesLoading, setNodesLoading] = useState(false)

  useEffect(() => {
    supabase
      .from('funnels')
      .select('id, name')
      .order('name')
      .then(({ data }) => setFunnels((data ?? []) as FunnelOption[]))
  }, [])

  useEffect(() => {
    if (!funnelId) {
      setNodes([])
      return
    }
    let cancelled = false
    setNodesLoading(true)
    supabase
      .from('funnel_nodes')
      .select('id, config')
      .eq('funnel_id', funnelId)
      .eq('type', 'message')
      .then(({ data }) => {
        if (cancelled) return
        const options = ((data ?? []) as { id: string; config: { label?: string; buttons?: { label?: string }[] } | null }[]).map((n) => ({
          id: n.id,
          label: n.config?.label?.trim() || 'Повідомлення без назви',
          hasButton: (n.config?.buttons ?? []).some((b) => b?.label),
        }))
        setNodes(options)
        setNodesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [funnelId])

  const selectedNode = nodes.find((n) => n.id === nodeId)

  return (
    <>
      <div className="field">
        <label>Тунель</label>
        <select
          className="input"
          value={funnelId}
          onChange={(e) => {
            onFunnelChange(e.target.value)
            onNodeChange('')
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
        <label>Вузол повідомлення (DM)</label>
        <select className="input" value={nodeId} onChange={(e) => onNodeChange(e.target.value)} disabled={!funnelId || nodesLoading}>
          <option value="">{!funnelId ? 'Спершу оберіть тунель' : nodesLoading ? 'Завантаження…' : 'Оберіть вузол'}</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
              {!n.hasButton ? ' — без кнопки!' : ''}
            </option>
          ))}
        </select>
        {warnOnMissingButton && selectedNode && !selectedNode.hasButton && (
          <p className="flow-node-hint" style={{ color: 'var(--danger)' }}>
            У цього вузла немає жодної кнопки. Перше DM-повідомлення на коментар обов'язково повинно мати кнопку (вимога Meta) — додайте кнопку в конструкторі тунелів, інакше збереження буде відхилено.
          </p>
        )}
      </div>
    </>
  )
}

// Plain card-styled row — deliberately not the adm-* admin classes (their
// --adm-line/--adm-glass custom properties are scoped to .adm, the platform
// mission-control wrapper this ordinary tenant-facing page doesn't use).
function TriggerRow({ active, title, meta, onEdit, onDelete }: { active: boolean; title: string; meta: string; onEdit: () => void; onDelete: () => void }) {
  return (
    <div
      className="card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.625rem',
        padding: '0.625rem 0.875rem',
        opacity: active ? 1 : 0.6,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
        <b>{title}</b>
        <small className="settings-row-hint">{meta}</small>
      </div>
      <div style={{ display: 'flex', gap: '0.375rem' }}>
        <button type="button" className="btn-icon-ghost" onClick={onEdit} aria-label="Редагувати">
          ✎
        </button>
        <button type="button" className="btn-icon-ghost" onClick={onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
    </div>
  )
}

function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

interface CommentTrigger {
  id: string
  name: string
  scope: 'all_posts' | 'all_lives' | 'specific_post'
  media_id: string | null
  include_keywords: string[]
  exclude_keywords: string[]
  reply_variants: string[]
  dm_funnel_node_id: string | null
  is_active: boolean
}

interface StoryTrigger {
  id: string
  name: string
  react_to_reply: boolean
  react_to_mention: boolean
  scope: 'all_stories' | 'specific_story'
  story_media_id: string | null
  active_from: string | null
  active_until: string | null
  auto_like: boolean
  include_keywords: string[]
  exclude_keywords: string[]
  reply_funnel_node_id: string | null
  is_active: boolean
}

function emptyComment(): Omit<CommentTrigger, 'id'> {
  return { name: '', scope: 'all_posts', media_id: null, include_keywords: [], exclude_keywords: [], reply_variants: [], dm_funnel_node_id: null, is_active: true }
}

function emptyStory(): Omit<StoryTrigger, 'id'> {
  return {
    name: '',
    react_to_reply: true,
    react_to_mention: true,
    scope: 'all_stories',
    story_media_id: null,
    active_from: null,
    active_until: null,
    auto_like: false,
    include_keywords: [],
    exclude_keywords: [],
    reply_funnel_node_id: null,
    is_active: true,
  }
}

function CommentTriggerForm({ initial, onSaved, onCancel }: { initial: CommentTrigger | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<Omit<CommentTrigger, 'id'>>(initial ?? emptyComment())
  const [funnelId, setFunnelId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await saveTrigger({
        kind: 'comment',
        id: initial?.id,
        name: form.name,
        scope: form.scope,
        mediaId: form.media_id,
        includeKeywords: form.include_keywords,
        excludeKeywords: form.exclude_keywords,
        replyVariants: form.reply_variants,
        dmFunnelNodeId: form.dm_funnel_node_id,
        isActive: form.is_active,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }} onSubmit={handleSubmit}>
      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}
      <div className="field">
        <label>Назва</label>
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Наприклад: «Ціна» під рілзами" required />
      </div>
      <div className="field">
        <label>Область дії</label>
        <select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as CommentTrigger['scope'] })}>
          <option value="all_posts">Усі пости</option>
          <option value="all_lives">Усі лайви</option>
          <option value="specific_post">Конкретний пост (за ID)</option>
        </select>
      </div>
      {form.scope === 'specific_post' && (
        <div className="field">
          <label>ID поста</label>
          <input className="input" value={form.media_id ?? ''} onChange={(e) => setForm({ ...form, media_id: e.target.value })} required />
        </div>
      )}
      <div className="field">
        <label>Ключові слова — містить (кожне з нового рядка, порожньо = будь-який коментар)</label>
        <textarea className="input" rows={2} value={form.include_keywords.join('\n')} onChange={(e) => setForm({ ...form, include_keywords: linesToArray(e.target.value) })} />
      </div>
      <div className="field">
        <label>Ключові слова — виключити</label>
        <textarea className="input" rows={2} value={form.exclude_keywords.join('\n')} onChange={(e) => setForm({ ...form, exclude_keywords: linesToArray(e.target.value) })} />
      </div>
      <div className="field">
        <label>Варіанти відповіді в коментарях (кожен з нового рядка — ротуються випадково)</label>
        <textarea className="input" rows={3} value={form.reply_variants.join('\n')} onChange={(e) => setForm({ ...form, reply_variants: linesToArray(e.target.value) })} placeholder="Дякуємо! Деталі надіслали в директ 👆" />
      </div>
      <FunnelNodePicker funnelId={funnelId} nodeId={form.dm_funnel_node_id ?? ''} onFunnelChange={setFunnelId} onNodeChange={(id) => setForm({ ...form, dm_funnel_node_id: id || null })} warnOnMissingButton />
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Активний
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? <IconSpinner size={14} /> : 'Зберегти'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Скасувати
        </button>
      </div>
    </form>
  )
}

function StoryTriggerForm({ initial, onSaved, onCancel }: { initial: StoryTrigger | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<Omit<StoryTrigger, 'id'>>(initial ?? emptyStory())
  const [funnelId, setFunnelId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await saveTrigger({
        kind: 'story',
        id: initial?.id,
        name: form.name,
        reactToReply: form.react_to_reply,
        reactToMention: form.react_to_mention,
        scope: form.scope,
        mediaId: form.story_media_id,
        activeFrom: form.active_from,
        activeUntil: form.active_until,
        autoLike: form.auto_like,
        includeKeywords: form.include_keywords,
        excludeKeywords: form.exclude_keywords,
        replyFunnelNodeId: form.reply_funnel_node_id,
        isActive: form.is_active,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }} onSubmit={handleSubmit}>
      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}
      <div className="field">
        <label>Назва</label>
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </div>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
          <input type="checkbox" checked={form.react_to_reply} onChange={(e) => setForm({ ...form, react_to_reply: e.target.checked })} />
          Реакція на reply в нашій Stories
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
          <input type="checkbox" checked={form.react_to_mention} onChange={(e) => setForm({ ...form, react_to_mention: e.target.checked })} />
          Реакція на mention у чужій Stories
        </label>
      </div>
      <div className="field">
        <label>Область дії</label>
        <select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as StoryTrigger['scope'] })}>
          <option value="all_stories">Усі Stories</option>
          <option value="specific_story">Конкретна Stories (за ID)</option>
        </select>
      </div>
      {form.scope === 'specific_story' && (
        <div className="field">
          <label>ID Stories</label>
          <input className="input" value={form.story_media_id ?? ''} onChange={(e) => setForm({ ...form, story_media_id: e.target.value })} required />
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Діє від</label>
          <input type="date" className="input" value={form.active_from ?? ''} onChange={(e) => setForm({ ...form, active_from: e.target.value || null })} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Діє до</label>
          <input type="date" className="input" value={form.active_until ?? ''} onChange={(e) => setForm({ ...form, active_until: e.target.value || null })} />
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
        <input type="checkbox" checked={form.auto_like} onChange={(e) => setForm({ ...form, auto_like: e.target.checked })} />
        Автолайк на реакцію користувача
      </label>
      <div className="field">
        <label>Ключові слова — містить</label>
        <textarea className="input" rows={2} value={form.include_keywords.join('\n')} onChange={(e) => setForm({ ...form, include_keywords: linesToArray(e.target.value) })} />
      </div>
      <div className="field">
        <label>Ключові слова — виключити</label>
        <textarea className="input" rows={2} value={form.exclude_keywords.join('\n')} onChange={(e) => setForm({ ...form, exclude_keywords: linesToArray(e.target.value) })} />
      </div>
      <FunnelNodePicker
        funnelId={funnelId}
        nodeId={form.reply_funnel_node_id ?? ''}
        onFunnelChange={setFunnelId}
        onNodeChange={(id) => setForm({ ...form, reply_funnel_node_id: id || null })}
        warnOnMissingButton={false}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Активний
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? <IconSpinner size={14} /> : 'Зберегти'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Скасувати
        </button>
      </div>
    </form>
  )
}

export default function InstagramTriggers() {
  const [commentTriggers, setCommentTriggers] = useState<CommentTrigger[]>([])
  const [storyTriggers, setStoryTriggers] = useState<StoryTrigger[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingComment, setEditingComment] = useState<CommentTrigger | 'new' | null>(null)
  const [editingStory, setEditingStory] = useState<StoryTrigger | 'new' | null>(null)
  // Drives the temporary "not connected yet" banner below — remove this
  // state and the banner together once Settings.tsx gets its Instagram card
  // (see the comment on the banner itself).
  const [instagramConnected, setInstagramConnected] = useState<boolean | null>(null)

  async function load() {
    setLoading(true)
    const [c, s, cred] = await Promise.all([
      supabase.from('instagram_comment_triggers').select('*').order('created_at', { ascending: false }),
      supabase.from('instagram_story_triggers').select('*').order('created_at', { ascending: false }),
      supabase.from('channel_credentials').select('created_at').eq('channel_type', 'instagram').maybeSingle(),
    ])
    if (c.error || s.error) {
      setError(c.error?.message ?? s.error?.message ?? 'Не вдалося завантажити тригери')
    } else {
      setCommentTriggers((c.data ?? []) as CommentTrigger[])
      setStoryTriggers((s.data ?? []) as StoryTrigger[])
      setInstagramConnected(!!cred.data)
      setError(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function deleteTrigger(kind: 'comment' | 'story', id: string) {
    if (!window.confirm('Видалити цей тригер?')) return
    try {
      await saveTrigger({ kind, id, delete: true })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
        <IconSpinner size={20} />
      </div>
    )
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            <IconInstagram size={20} style={{ marginRight: '0.5rem', verticalAlign: '-3px' }} />
            Instagram: коментарі та Stories
          </h1>
          <p className="page-description">Точки входу з коментарів під постами й реакцій на Stories — ведуть у той самий граф тунелів, що і Telegram чи WhatsApp.</p>
        </div>
      </div>

      {/* Temporary: Settings.tsx doesn't have an Instagram connection card
          yet (blocked earlier by a parallel session, now just not built).
          Remove this whole block once that card exists and links here —
          this page keeps working by direct link either way. */}
      {instagramConnected === false && (
        <div className="alert alert-warning" style={{ marginBottom: '1.25rem' }}>
          <IconAlert size={16} />
          <span>Instagram ще не підключено. Ця сторінка керує тригерами на коментарі/Stories — вони запрацюють, коли буде додано підключення акаунта (Налаштування → Інтеграції).</span>
        </div>
      )}

      <div className="settings-group" style={{ marginBottom: '1.25rem' }}>
        <p style={{ fontSize: '0.875rem', color: 'var(--fg-muted)', lineHeight: 1.6, margin: 0 }}>
          Instagram-тригери — це два незалежні механізми. <b>Коментар</b> під постом чи рілзом із певними словами: бот
          публічно відповідає в коментарях і водночас шле DM з обраного вузла тунелю. <b>Реакція чи згадка в Stories</b>:
          бот шле DM у відповідь. Обидва ведуть у той самий граф тунелів, що і Telegram чи WhatsApp.
        </p>
      </div>

      <div className="alert alert-info" style={{ marginBottom: '1.5rem' }}>
        <IconAlert size={16} />
        <span>
          Перше DM-повідомлення на коментар обов'язково має містити кнопку — це вимога Meta, без неї збереження тригера
          буде відхилено.
        </span>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <section className="settings-group" style={{ marginBottom: '1.5rem' }}>
        <header className="settings-group-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
          <div>
            <h2>Коментарі → DM</h2>
            <p>Слово чи фраза під постом запускає публічну відповідь і приватне DM з обраного вузла тунелю.</p>
          </div>
          {editingComment === null && (
            <button type="button" className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={() => setEditingComment('new')}>
              <IconPlus size={13} /> Новий тригер
            </button>
          )}
        </header>
        {commentTriggers.length === 0 && editingComment === null && (
          <p className="settings-row-hint">Тригерів ще немає. Приклад: слово «ціна» під постом → DM з прайсом.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {commentTriggers.map((t) => (
            <TriggerRow
              key={t.id}
              active={t.is_active}
              title={t.name}
              meta={`${t.scope === 'all_posts' ? 'усі пости' : t.scope === 'all_lives' ? 'усі лайви' : `пост ${t.media_id}`}${t.dm_funnel_node_id ? '' : ' · DM не налаштовано!'}`}
              onEdit={() => setEditingComment(t)}
              onDelete={() => deleteTrigger('comment', t.id)}
            />
          ))}
        </div>
        {editingComment !== null && (
          <CommentTriggerForm
            initial={editingComment === 'new' ? null : editingComment}
            onSaved={() => {
              setEditingComment(null)
              void load()
            }}
            onCancel={() => setEditingComment(null)}
          />
        )}
      </section>

      <section className="settings-group">
        <header className="settings-group-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
          <div>
            <h2>Stories</h2>
            <p>Reply чи згадка в Stories запускає DM з обраного вузла тунелю.</p>
          </div>
          {editingStory === null && (
            <button type="button" className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={() => setEditingStory('new')}>
              <IconPlus size={13} /> Новий тригер
            </button>
          )}
        </header>
        {storyTriggers.length === 0 && editingStory === null && (
          <p className="settings-row-hint">Тригерів ще немає. Приклад: лід відповів на вашу Stories → DM з подякою і наступним кроком.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {storyTriggers.map((t) => (
            <TriggerRow
              key={t.id}
              active={t.is_active}
              title={t.name}
              meta={`${[t.react_to_reply ? 'reply' : null, t.react_to_mention ? 'mention' : null].filter(Boolean).join(' · ')} · ${
                t.scope === 'all_stories' ? 'усі Stories' : `Stories ${t.story_media_id}`
              }${t.auto_like ? ' · автолайк' : ''}`}
              onEdit={() => setEditingStory(t)}
              onDelete={() => deleteTrigger('story', t.id)}
            />
          ))}
        </div>
        {editingStory !== null && (
          <StoryTriggerForm
            initial={editingStory === 'new' ? null : editingStory}
            onSaved={() => {
              setEditingStory(null)
              void load()
            }}
            onCancel={() => setEditingStory(null)}
          />
        )}
      </section>
    </div>
  )
}
