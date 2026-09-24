import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { RealtimePostgresInsertPayload } from '@supabase/supabase-js'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabaseClient'
import { IconArchiveBox, IconBan, IconBolt, IconChat, IconClose, IconCpu, IconFile, IconInbox, IconLink, IconPaperclip, IconSpinner, IconUser } from '../components/icons'
import Marquee from '../components/Marquee'
import LeadProfile from '../components/LeadProfile'
import LeadIndicatorIcons from '../components/LeadIndicatorIcons'
import HoverTooltip from '../components/HoverTooltip'
import { useLeadIndicators } from '../hooks/useLeadIndicators'
import { useAiPausedThreads } from '../hooks/useAiPausedThreads'
import { setActiveThreadId } from '../lib/activeThread'
import { leadDisplayName } from '../lib/leadDisplayName'

type LeadStatus = 'active' | 'blocked' | 'archived'

interface LeadRef {
  id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  external_id: string
  status: LeadStatus
  created_at: string
  source_link_id: string | null
  manager_notes: string | null
}

// Set by the backend for messages that aren't ordinary text — a lead-gen
// link start, or an inline-button tap — so the feed can render them as
// system markers instead of bubbles.
// What the lead actually saw, stored next to the text: the same attachment
// types the message builder produces, plus the buttons the message offered.
interface MessageAttachment {
  type: string
  url: string
  filename?: string
}

interface MessageButton {
  id?: string
  label?: string
  actionType?: string
  url?: string | null
}

interface MessageMeta {
  type?: string
  link_name?: string
  funnel_name?: string
  label?: string
  attachments?: MessageAttachment[]
  buttons?: MessageButton[]
}

const DOC_LIKE = new Set(['document', 'file'])

const PENDING_POLL_MS = 4000
const PENDING_POLL_LIMIT = 20

function hasVoice(meta: MessageMeta | null | undefined): boolean {
  return (meta?.attachments ?? []).some((a) => a.type === 'voice' || a.type === 'audio')
}

// ---------- Manager attach-to-reply (Chats.tsx's own send box) — separate
// from AttachmentView above, which renders an attachment already on a sent
// message. This is the pre-send draft: pick a file, upload it, preview it,
// optionally remove it, then it rides along with the next reply. ----------

const MAX_ATTACH_BYTES = 4 * 1024 * 1024
const MAX_ATTACH_MB = Math.floor(MAX_ATTACH_BYTES / 1024 / 1024)

type AttachDraftType = 'photo' | 'video' | 'audio' | 'document'
interface AttachDraft {
  type: AttachDraftType
  url: string
  filename: string
}

function attachTypeForFile(file: File): AttachDraftType {
  if (file.type.startsWith('image/')) return 'photo'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'document'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const commaIdx = result.indexOf(',')
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// One <video>/<audio>/<img> per type rather than a link: a manager scanning a
// thread shouldn't have to open a new tab to find out what the lead sent.
function AttachmentView({
  attachment,
  onZoom,
}: {
  attachment: MessageAttachment
  onZoom: (url: string) => void
}) {
  const { type, url, filename } = attachment

  if (type === 'photo' || type === 'animation') {
    return (
      <button type="button" className="msg-media-image" onClick={() => onZoom(url)} title="Відкрити на весь розмір">
        <img src={url} alt={filename ?? 'Зображення'} loading="lazy" />
      </button>
    )
  }

  if (type === 'video' || type === 'video_note') {
    return <video className="msg-media-video" src={url} controls preload="metadata" />
  }

  if (type === 'audio' || type === 'voice') {
    return <audio className="msg-media-audio" src={url} controls preload="metadata" />
  }

  if (DOC_LIKE.has(type)) {
    return (
      <a className="msg-media-file" href={url} target="_blank" rel="noreferrer" download>
        <IconFile size={15} aria-hidden="true" />
        <span>{filename ?? 'Файл'}</span>
      </a>
    )
  }

  // Unknown/poll and anything added later — still reachable, never silently
  // dropped from the transcript.
  return (
    <a className="msg-media-file" href={url} target="_blank" rel="noreferrer">
      <IconFile size={15} aria-hidden="true" />
      <span>{filename ?? type}</span>
    </a>
  )
}

// Manual and automatic actions on the lead, rendered inline with the
// transcript. Read-only here: this page never writes to lead_activity_log.
interface ActivityRow {
  id: string
  action_type: string
  actor_type: 'manager' | 'system' | 'ai'
  details: Record<string, unknown> | null
  created_at: string
}

type FeedItem =
  | { kind: 'message'; id: string; created_at: string; message: MessageRow }
  | { kind: 'activity'; id: string; created_at: string; activity: ActivityRow }

const STATUS_LABELS: Record<string, string> = {
  blocked: 'заблокований',
  archived: 'в архіві',
  active: 'активний',
  closed: 'закритий',
}

function quoted(value: unknown): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : '—'
  return `«${text}»`
}

function shownValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '—'
}

// Deliberately impersonal wording ("Додано тег", not "Олена додала тег"):
// the actor's name is all we have — never their gender — and a guessed verb
// ending would misgender real people in their own CRM. The actor is named in
// the suffix instead.
function activityText(entry: ActivityRow): string {
  const d = entry.details ?? {}
  switch (entry.action_type) {
    case 'tag_added':
      return `Додано тег ${quoted(d.tag_name)}`
    case 'tag_removed':
      return `Знято тег ${quoted(d.tag_name)}`
    case 'variable_changed':
      return `Змінна ${quoted(d.key)}: ${shownValue(d.old_value)} → ${shownValue(d.new_value)}`
    case 'stage_changed': {
      const to = quoted(d.to_stage)
      const from = d.from_stage ? `${quoted(d.from_stage)} → ` : ''
      const sum = d.value !== null && d.value !== undefined ? `, сума ${d.value}` : ''
      return `Етап: ${from}${to}${sum}`
    }
    case 'task_created':
      return `Створено задачу ${quoted(d.title)}`
    case 'task_completed':
      return `Виконано задачу ${quoted(d.title)}`
    case 'task_deleted':
      return `Видалено задачу ${quoted(d.title)}`
    case 'funnel_switched':
      return `Воронка ${quoted(d.funnel_name)}: перемкнено на ${quoted(d.node_label)}`
    case 'funnel_stopped':
      return `Воронку ${quoted(d.funnel_name)} зупинено`
    case 'funnel_auto_stopped': {
      const days = typeof d.days_inactive === 'number' ? d.days_inactive : null
      return `Воронку ${quoted(d.funnel_name)}${d.node_label ? ` (${quoted(d.node_label)})` : ''} автоматично зупинено${days !== null ? ` — без руху ${days} дн.` : ''}`
    }
    case 'funnel_connected':
      return `Підключено до воронки ${quoted(d.funnel_name)} → ${quoted(d.node_label)}`
    case 'status_changed':
      return `Статус: ${STATUS_LABELS[String(d.new_status)] ?? shownValue(d.new_status)}`
    case 'ai_paused_by_manager':
      return d.funnel_name
        ? `AI зупинено — менеджер відповів вручну (${quoted(d.funnel_name)}${d.node_label ? ` → ${quoted(d.node_label)}` : ''})`
        : 'AI зупинено — менеджер відповів вручну'
    default:
      return entry.action_type
  }
}

function activityActor(entry: ActivityRow): string {
  if (entry.actor_type === 'system') return 'автоматично'
  if (entry.actor_type === 'ai') return 'AI'
  const name = entry.details?.actor_name
  return typeof name === 'string' && name.trim() ? name.trim() : 'менеджер'
}

// Colour groups the action families so the timeline is scannable without
// reading every line: green for progress, red for removals, amber for tasks.
function activityTone(actionType: string): string {
  if (actionType === 'stage_changed' || actionType === 'tag_added' || actionType === 'funnel_connected') return 'is-positive'
  if (
    actionType === 'tag_removed' ||
    actionType === 'funnel_stopped' ||
    actionType === 'funnel_auto_stopped' ||
    actionType === 'task_deleted' ||
    actionType === 'ai_paused_by_manager'
  )
    return 'is-negative'
  if (actionType.startsWith('task_')) return 'is-task'
  return ''
}

interface MessageRow {
  id: string
  body: string | null
  direction: 'inbound' | 'outbound'
  created_at: string
  meta?: MessageMeta | null
  /** Speech-to-text of a voice attachment; null until transcribe-voice fills it. */
  transcript?: string | null
  /** 'ai' | 'agent' | 'system' | 'lead' | null — drives the outbound bubble color. */
  sender?: string | null
}

interface ThreadRow {
  id: string
  channel_type: string
  created_at: string
  updated_at: string
  unread_count: number
  status: 'open' | 'closed'
  leads: LeadRef | null
  messages: MessageRow[]
}

const THREADS_PAGE_SIZE = 20
const MESSAGES_PAGE_SIZE = 20

const THREAD_SELECT =
  'id, channel_type, created_at, updated_at, unread_count, status, leads ( id, username, first_name, last_name, external_id, status, created_at, source_link_id, manager_notes ), messages ( id, body, direction, created_at )'

interface MessageInsertPayload {
  id: string
  org_id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
  body: string | null
  created_at: string
  sender: string | null
}

// Thread-list preview only: a list row has no day separator above it, so an
// older thread shows the date instead of a time nobody can place.
function formatThreadListTime(iso: string) {
  const date = new Date(iso)
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })
}

// Always HH:MM. Inside the feed the day is already stated once by the
// separator above the group, so a per-message date would both repeat it and
// hide the one thing the stamp is there for.
function formatMessageTime(iso: string) {
  return new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
}

function isSameDay(a: string, b: string) {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

// "Сьогодні" / "Вчора" / "29 серпня 2026" for the separators between days.
function formatDayLabel(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Сьогодні'
  if (date.toDateString() === yesterday.toDateString()) return 'Вчора'
  return date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })
}

function leadLabel(lead: LeadRef | null) {
  return leadDisplayName(lead)
}

interface QuickReplyRow {
  id: string
  title: string
  text: string
}

// Trigger + popover for inserting a canned reply into the message field
// (never sends it — the manager can still edit before hitting "Надіслати").
// The catalog itself is managed on /dashboard/elements — this also offers an
// inline "+ Створити нову" so a manager mid-chat doesn't have to leave to add
// one, and the new reply is usable immediately without a page reload there.
function QuickReplyPicker({ onInsert }: { onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const [replies, setReplies] = useState<QuickReplyRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newText, setNewText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  function load() {
    supabase
      .from('quick_replies')
      .select('id, title, text')
      .order('title')
      .then(({ data }) => {
        setReplies((data ?? []) as QuickReplyRow[])
        setLoaded(true)
      })
  }

  function toggleOpen() {
    setOpen((prev) => {
      const next = !prev
      if (next && !loaded) load()
      if (!next) {
        setCreating(false)
        setSearch('')
        setError(null)
      }
      return next
    })
  }

  // Outside click closes the popover — the reply textarea and everything
  // else on the page stays clickable, only this one listener is added while
  // it's actually open.
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  function handlePick(reply: QuickReplyRow) {
    onInsert(reply.text)
    setOpen(false)
  }

  // Plain function, not a form onSubmit — see the JSX below for why: this
  // whole popover sits inside Chats.tsx's own <form className="reply-box">
  // (the "Надіслати" form), and a nested <form> is invalid HTML. Confirmed
  // live: a browser silently drops the submit entirely for a button owned by
  // a form that's itself inside another form — no submit event fires on
  // either form, no network call ever happens. That's the whole bug this
  // component had.
  async function handleCreate() {
    if (!newTitle.trim() || !newText.trim()) return
    setSaving(true)
    setError(null)

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSaving(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-quick-reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ title: newTitle.trim(), text: newText.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося зберегти швидку відповідь')
      } else {
        const saved = data.reply as QuickReplyRow
        setReplies((prev) => [...prev, saved].sort((a, b) => a.title.localeCompare(b.title)))
        setNewTitle('')
        setNewText('')
        setCreating(false)
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSaving(false)
    }
  }

  const filtered = search.trim()
    ? replies.filter(
        (r) => r.title.toLowerCase().includes(search.trim().toLowerCase()) || r.text.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : replies

  return (
    <div className="quick-reply-picker" ref={containerRef}>
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        onClick={toggleOpen}
        title="Швидкі відповіді"
        aria-label="Швидкі відповіді"
        aria-expanded={open}
      >
        <IconBolt size={16} />
      </button>

      {open && (
        <div className="quick-reply-popover">
          {!creating && (
            <input
              className="input quick-reply-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Пошук…"
              autoFocus
              aria-label="Пошук швидких відповідей"
            />
          )}

          {error && (
            <div className="alert alert-error" style={{ margin: '0 0 0.5rem' }}>
              {error}
            </div>
          )}

          {creating ? (
            // A <div>, not a <form> — this popover already lives inside
            // Chats.tsx's own reply <form>, and a nested <form> silently
            // drops every submit (see handleCreate's comment). Enter in the
            // title field still submits, via onKeyDown below.
            <div className="quick-reply-create-form">
              <input
                className="input"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleCreate()
                  }
                }}
                placeholder="Назва"
                autoFocus
              />
              <textarea
                className="input"
                rows={3}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Текст відповіді…"
              />
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || !newTitle.trim() || !newText.trim()}
                  onClick={() => void handleCreate()}
                >
                  {saving ? <IconSpinner size={14} /> : 'Зберегти'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)} disabled={saving}>
                  Скасувати
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="quick-reply-list">
                {!loaded ? (
                  <p className="settings-row-hint">Завантаження…</p>
                ) : filtered.length === 0 ? (
                  <p className="settings-row-hint">{replies.length === 0 ? 'Ще немає швидких відповідей' : 'Нічого не знайдено'}</p>
                ) : (
                  filtered.map((r) => (
                    <button
                      type="button"
                      key={r.id}
                      className="quick-reply-item"
                      onClick={() => handlePick(r)}
                      title={r.text}
                    >
                      <span className="quick-reply-item-title">{r.title}</span>
                      <span className="quick-reply-item-text">{r.text}</span>
                    </button>
                  ))
                )}
              </div>
              <button type="button" className="quick-reply-create-toggle" onClick={() => setCreating(true)}>
                + Створити нову
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function Chats() {
  // Only used for the one-time ?thread= deep link below — no other read of
  // the URL happens in this file.
  const [searchParams] = useSearchParams()
  const [threads, setThreads] = useState<ThreadRow[]>([])
  const [threadsLoading, setThreadsLoading] = useState(true)
  const [threadsError, setThreadsError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [zoomedImage, setZoomedImage] = useState<string | null>(null)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)

  const [attachDraft, setAttachDraft] = useState<AttachDraft | null>(null)
  const [attachUploading, setAttachUploading] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const attachInputRef = useRef<HTMLInputElement>(null)

  const [orgId, setOrgId] = useState<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)

  const [threadsCursor, setThreadsCursor] = useState<string | null>(null)
  const [threadsHasMore, setThreadsHasMore] = useState(true)
  const [threadsLoadingMore, setThreadsLoadingMore] = useState(false)

  const [messagesCursor, setMessagesCursor] = useState<string | null>(null)
  const [messagesHasMore, setMessagesHasMore] = useState(true)
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false)
  const messageListRef = useRef<HTMLDivElement>(null)
  const pendingUnreadRef = useRef(0)
  const pendingScrollRef = useRef(false)
  const firstUnreadRef = useRef<HTMLDivElement>(null)
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null)

  const [onlyUnread, setOnlyUnread] = useState(false)
  const [showClosed, setShowClosed] = useState(false)

  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  async function markThreadRead(threadId: string) {
    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) return

    await fetch('/.netlify/functions/mark-thread-read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ threadId }),
    })
  }

  function selectThread(threadId: string) {
    // Captured before the badge is cleared: the feed uses it to place the
    // "Нові повідомлення" divider and to scroll there instead of the bottom.
    const opening = threads.find((t) => t.id === threadId)
    pendingUnreadRef.current = opening?.unread_count ?? 0
    setSelectedId(threadId)
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, unread_count: 0 } : t)))
    void markThreadRead(threadId)
    // A stale profile panel for the previous lead would be confusing left
    // open across a switch — one click reopens it for the new one.
    setProfileOpen(false)
  }

  // Deep link from /dashboard/crm ("open this lead's chat"): the target
  // thread may not be in the first page of `threads` yet, so it's fetched
  // directly by id — same shape as the realtime "brand-new thread" handler
  // below — and prepended before selecting it. Runs once on mount only; the
  // CRM page is the only place that ever sets this param.
  useEffect(() => {
    const threadId = searchParams.get('thread')
    if (!threadId) return

    let cancelled = false
    supabase
      .from('threads')
      .select(THREAD_SELECT)
      .eq('id', threadId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        const row = data as unknown as ThreadRow
        setThreads((prev) => (prev.some((t) => t.id === row.id) ? prev : [row, ...prev]))
        selectThread(row.id)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shared sync target for both Block/Archive/Close triggers: LeadProfile's
  // own buttons (via the onLeadStatusChange/onThreadClosed props below) and
  // the header's duplicate buttons further down, which call the same
  // endpoints directly. Either one lands here, so `threads` — and every
  // badge derived from it — updates identically no matter which fired.
  function handleLeadStatusChange(leadId: string, status: 'blocked' | 'archived') {
    setThreads((prev) => prev.map((t) => (t.leads?.id === leadId ? { ...t, leads: { ...t.leads!, status } } : t)))
  }

  function handleThreadClosed(threadId: string) {
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, status: 'closed' } : t)))
  }

  function handleThreadOpened(threadId: string) {
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, status: 'open' } : t)))
  }

  // Permanent deletion (LeadProfile's "Видалити") — the row is gone from the
  // database, not just recategorized like block/archive, so every thread
  // belonging to this lead (a lead can have more than one channel) drops out
  // of the list, the profile drawer closes, and the open thread is
  // deselected if it was one of the deleted lead's.
  function handleLeadDeleted(leadId: string) {
    setProfileOpen(false)
    if (selectedThread?.leads?.id === leadId) setSelectedId(null)
    setThreads((prev) => prev.filter((t) => t.leads?.id !== leadId))
  }

  // Header duplicate of LeadProfile's own Block/Archive/Close-thread buttons
  // — same endpoints, same confirm prompts, same success handling, just a
  // second UI trigger that's always visible regardless of whether the profile
  // panel is open. Its pending/error state is its own: LeadProfile manages
  // its internal copy independently, and isolating this one means neither
  // trigger's in-flight state leaks into the other's button.
  const [headerActionPending, setHeaderActionPending] = useState<'blocked' | 'archived' | 'closed' | 'opened' | null>(null)
  const [headerActionError, setHeaderActionError] = useState<string | null>(null)

  // Separate from the header's own pending/error state above, same
  // isolation principle: reopening straight from the closed-filter list (no
  // thread selected, header not even visible) needs its own per-row
  // pending marker rather than the header's single action-type flag.
  const [reopeningThreadId, setReopeningThreadId] = useState<string | null>(null)

  async function headerUpdateLeadStatus(leadId: string, status: 'blocked' | 'archived') {
    setHeaderActionError(null)
    setHeaderActionPending(status)

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      setHeaderActionError('Сесія недійсна, увійдіть знову')
      setHeaderActionPending(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/update-lead-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId, status }),
      })
      const data = await res.json()
      if (!res.ok) {
        setHeaderActionError(data.error ?? 'Не вдалося оновити статус ліда')
        return
      }
      handleLeadStatusChange(leadId, status)
    } catch {
      setHeaderActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setHeaderActionPending(null)
    }
  }

  function handleHeaderBlock(lead: LeadRef) {
    if (!window.confirm(`Заблокувати ${leadLabel(lead)}? Лід більше не отримуватиме повідомлень від сценаріїв.`)) return
    void headerUpdateLeadStatus(lead.id, 'blocked')
  }

  function handleHeaderArchive(lead: LeadRef) {
    if (!window.confirm(`Архівувати ${leadLabel(lead)}? Тред зникне зі стандартного списку чатів.`)) return
    void headerUpdateLeadStatus(lead.id, 'archived')
  }

  async function handleHeaderCloseThread(threadId: string) {
    setHeaderActionError(null)
    setHeaderActionPending('closed')

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      setHeaderActionError('Сесія недійсна, увійдіть знову')
      setHeaderActionPending(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/close-thread', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ threadId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setHeaderActionError(data.error ?? 'Не вдалося закрити тред')
        return
      }
      handleThreadClosed(threadId)
    } catch {
      setHeaderActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setHeaderActionPending(null)
    }
  }

  // Symmetric counterpart to handleHeaderCloseThread — same endpoint, just
  // action: 'open' instead of the implicit default 'close'.
  async function handleHeaderOpenThread(threadId: string) {
    setHeaderActionError(null)
    setHeaderActionPending('opened')

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      setHeaderActionError('Сесія недійсна, увійдіть знову')
      setHeaderActionPending(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/close-thread', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ threadId, action: 'open' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setHeaderActionError(data.error ?? 'Не вдалося відкрити тред')
        return
      }
      handleThreadOpened(threadId)
    } catch {
      setHeaderActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setHeaderActionPending(null)
    }
  }

  // List-row reopen (closed-filter view) — deliberately not routed through
  // handleHeaderOpenThread above: that one's pending/error state is scoped
  // to whichever thread is currently selected/open, and a row here is
  // neither. Same endpoint call, its own isolated pending marker.
  async function handleListReopenThread(threadId: string) {
    setReopeningThreadId(threadId)

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      setReopeningThreadId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/close-thread', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ threadId, action: 'open' }),
      })
      if (res.ok) handleThreadOpened(threadId)
    } finally {
      setReopeningThreadId(null)
    }
  }

  // Runs after the message rows are committed, so the divider ref exists and
  // scrollHeight is final. Lands on the first unread message when there is
  // one, otherwise at the bottom.
  useLayoutEffect(() => {
    if (!pendingScrollRef.current) return
    pendingScrollRef.current = false

    const list = messageListRef.current
    if (!list) return

    if (firstUnreadRef.current) {
      firstUnreadRef.current.scrollIntoView({ block: 'center' })
    } else {
      list.scrollTop = list.scrollHeight
    }
  }, [messages, firstUnreadId])

  useEffect(() => {
    let cancelled = false

    supabase
      .auth.getUser()
      .then(({ data }) => {
        if (cancelled || !data.user) return
        return supabase.from('profiles').select('org_id').eq('id', data.user.id).single()
      })
      .then((result) => {
        if (cancelled || !result) return
        if (!result.error && result.data) setOrgId(result.data.org_id as string)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Live-updates the thread list preview/order and, if the affected thread is
  // open, appends to the message history — no manual refresh needed.
  useEffect(() => {
    if (!orgId) return

    const channel = supabase
      .channel(`messages-${orgId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` },
        (payload: RealtimePostgresInsertPayload<MessageInsertPayload>) => {
          const row = payload.new
          const isOpenThread = selectedIdRef.current === row.thread_id

          setThreads((prev) => {
            const idx = prev.findIndex((t) => t.id === row.thread_id)
            if (idx === -1) return prev
            const alreadyKnown = prev[idx].messages[0]?.id === row.id
            if (alreadyKnown) return prev
            const bumpUnread = row.direction === 'inbound' && !isOpenThread
            const updated: ThreadRow = {
              ...prev[idx],
              messages: [row],
              updated_at: row.created_at,
              unread_count: bumpUnread ? prev[idx].unread_count + 1 : prev[idx].unread_count,
            }
            const rest = prev.filter((_, i) => i !== idx)
            return [updated, ...rest]
          })

          if (isOpenThread) {
            setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
            // Telegram-webhook.ts already bumped unread_count server-side —
            // the agent is actively viewing this thread, so zero it back out.
            if (row.direction === 'inbound') void markThreadRead(row.thread_id)
          }
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orgId])

  // Separate channel: a brand-new thread (first-ever message from a lead we
  // haven't seen before) isn't in `threads` yet, so the messages subscription
  // above can't attach its preview — fetch the new row (with its lead) and
  // prepend it here instead.
  useEffect(() => {
    if (!orgId) return

    const channel = supabase
      .channel(`threads-${orgId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'threads', filter: `org_id=eq.${orgId}` },
        (payload: RealtimePostgresInsertPayload<{ id: string }>) => {
          const threadId = payload.new.id

          supabase
            .from('threads')
            .select(THREAD_SELECT)
            .eq('id', threadId)
            .single()
            .then(({ data, error }) => {
              if (error || !data) return
              const row = data as unknown as ThreadRow
              setThreads((prev) => (prev.some((t) => t.id === row.id) ? prev : [row, ...prev]))
            })
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orgId])

  useEffect(() => {
    let cancelled = false

    supabase
      .from('threads')
      .select(THREAD_SELECT)
      .order('updated_at', { ascending: false })
      .order('created_at', { referencedTable: 'messages', ascending: false })
      .limit(1, { referencedTable: 'messages' })
      .limit(THREADS_PAGE_SIZE)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setThreadsError(error.message)
        } else {
          const rows = (data ?? []) as unknown as ThreadRow[]
          setThreads(rows)
          setThreadsCursor(rows[rows.length - 1]?.updated_at ?? null)
          setThreadsHasMore(rows.length === THREADS_PAGE_SIZE)
        }
        setThreadsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function loadMoreThreads() {
    if (!threadsCursor || !threadsHasMore || threadsLoadingMore) return
    setThreadsLoadingMore(true)

    const { data, error } = await supabase
      .from('threads')
      .select(THREAD_SELECT)
      .lt('updated_at', threadsCursor)
      .order('updated_at', { ascending: false })
      .order('created_at', { referencedTable: 'messages', ascending: false })
      .limit(1, { referencedTable: 'messages' })
      .limit(THREADS_PAGE_SIZE)

    if (!error && data) {
      const rows = data as unknown as ThreadRow[]
      setThreads((prev) => [...prev, ...rows])
      setThreadsCursor(rows[rows.length - 1]?.updated_at ?? threadsCursor)
      setThreadsHasMore(rows.length === THREADS_PAGE_SIZE)
    }
    setThreadsLoadingMore(false)
  }

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    setMessagesLoading(true)
    setReply('')
    setReplyError(null)
    setMessagesCursor(null)
    setMessagesHasMore(true)

    supabase
      .from('messages')
      .select('id, body, direction, created_at, meta, transcript, sender')
      .eq('thread_id', selectedId)
      .order('created_at', { ascending: false })
      .limit(MESSAGES_PAGE_SIZE)
      .then(({ data, error }) => {
        if (cancelled) return
        if (!error && data) {
          const rows = (data as MessageRow[]).slice().reverse()
          setMessages(rows)
          setMessagesCursor(rows[0]?.created_at ?? null)
          setMessagesHasMore(data.length === MESSAGES_PAGE_SIZE)

          // The unread ones are the last N inbound messages, N being the
          // badge count captured when the thread was opened.
          const unread = pendingUnreadRef.current
          const inbound = rows.filter((r) => r.direction === 'inbound')
          const firstUnread = unread > 0 && inbound.length >= unread ? inbound[inbound.length - unread] : null
          setFirstUnreadId(firstUnread?.id ?? null)

          // Actual scrolling happens in the layout effect below: at this point
          // React hasn't committed the new rows, so the divider ref is still
          // null and scrollHeight is stale.
          pendingScrollRef.current = true
        }
        setMessagesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedId])

  async function loadOlderMessages() {
    if (!selectedId || !messagesCursor || !messagesHasMore || messagesLoadingMore) return
    setMessagesLoadingMore(true)

    const el = messageListRef.current
    const prevScrollHeight = el?.scrollHeight ?? 0
    const prevScrollTop = el?.scrollTop ?? 0

    const { data, error } = await supabase
      .from('messages')
      .select('id, body, direction, created_at, meta, transcript, sender')
      .eq('thread_id', selectedId)
      .lt('created_at', messagesCursor)
      .order('created_at', { ascending: false })
      .limit(MESSAGES_PAGE_SIZE)

    if (!error && data) {
      const older = (data as MessageRow[]).slice().reverse()
      setMessages((prev) => [...older, ...prev])
      setMessagesCursor(older[0]?.created_at ?? messagesCursor)
      setMessagesHasMore(data.length === MESSAGES_PAGE_SIZE)

      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevScrollHeight + prevScrollTop
      })
    }
    setMessagesLoadingMore(false)
  }

  async function handleAttachFile(file: File) {
    if (file.size > MAX_ATTACH_BYTES) {
      setAttachError(`Файл завеликий (макс. ${MAX_ATTACH_MB}MB)`)
      return
    }
    setAttachUploading(true)
    setAttachError(null)

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      setAttachError('Сесія недійсна, увійдіть знову')
      setAttachUploading(false)
      return
    }

    try {
      const dataBase64 = await blobToBase64(file)
      // Same endpoint and bucket the funnel builder's own message-node
      // attachments already use — nothing new on the storage side.
      const res = await fetch('/.netlify/functions/upload-attachment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64 }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAttachError(data.error ?? 'Не вдалося завантажити файл')
      } else {
        setAttachDraft({ type: attachTypeForFile(file), url: data.url, filename: data.filename ?? file.name })
      }
    } catch {
      setAttachError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setAttachUploading(false)
    }
  }

  async function handleReplySubmit(event: FormEvent) {
    event.preventDefault()
    if (!selectedId || (!reply.trim() && !attachDraft) || sending) return

    setSending(true)
    setReplyError(null)

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token

    if (!accessToken) {
      setReplyError('Сесія недійсна, увійдіть знову')
      setSending(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/send-message', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          threadId: selectedId,
          text: reply,
          attachments: attachDraft ? [attachDraft] : undefined,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setReplyError(data.error ?? 'Не вдалося надіслати повідомлення')
      } else {
        if (data.message) setMessages((prev) => [...prev, data.message as MessageRow])
        setReply('')
        setAttachDraft(null)
      }
    } catch {
      setReplyError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSending(false)
    }
  }

  // Published so the layout's notification sound can stay quiet for the
  // thread that's actually on screen. Read-only for this page: nothing here
  // consumes it back.
  useEffect(() => {
    setActiveThreadId(selectedId)
    return () => setActiveThreadId(null)
  }, [selectedId])

  const selectedThread = threads.find((t) => t.id === selectedId) ?? null
  const selectedLeadId = selectedThread?.leads?.id ?? null

  // Separate fetch, separate state: the message list keeps its own cursor
  // pagination untouched, and this is small enough to load whole.
  useEffect(() => {
    if (!selectedLeadId) {
      setActivity([])
      return
    }
    let cancelled = false

    void supabase
      .from('lead_activity_log')
      .select('id, action_type, actor_type, details, created_at')
      .eq('lead_id', selectedLeadId)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (!error && data) setActivity(data as ActivityRow[])
      })

    return () => {
      cancelled = true
    }
  }, [selectedLeadId])

  // Transcripts arrive a few seconds after the message does. Polled rather
  // than pushed: the existing Realtime channel is INSERT-only and deliberately
  // left alone, and this asks only about the handful of clips still pending,
  // stopping as soon as they land (or after PENDING_POLL_LIMIT tries, so a
  // permanently failed transcription can't poll forever).
  const pendingTranscriptIds = messages
    .filter((m) => hasVoice(m.meta) && !m.transcript)
    .map((m) => m.id)
    .join(',')

  useEffect(() => {
    if (!pendingTranscriptIds) return
    const ids = pendingTranscriptIds.split(',')
    let cancelled = false
    let tries = 0

    const timer = setInterval(() => {
      tries += 1
      if (tries > PENDING_POLL_LIMIT) {
        clearInterval(timer)
        return
      }

      void supabase
        .from('messages')
        .select('id, transcript')
        .in('id', ids)
        .not('transcript', 'is', null)
        .then(({ data, error }) => {
          if (cancelled || error || !data || data.length === 0) return
          const byId = new Map(data.map((r) => [r.id as string, r.transcript as string]))
          setMessages((prev) => prev.map((m) => (byId.has(m.id) ? { ...m, transcript: byId.get(m.id)! } : m)))
        })
    }, PENDING_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pendingTranscriptIds])

  // Render-only merge — `messages` itself is never mutated, so Realtime and
  // the "load older" cursor keep working exactly as before. Activity older
  // than the loaded window is held back: it would otherwise pile up above the
  // first message and look like it happened at the top of the conversation.
  const feedItems: FeedItem[] = (() => {
    const items: FeedItem[] = messages.map((m) => ({ kind: 'message', id: m.id, created_at: m.created_at, message: m }))
    const oldestLoaded = messages[0]?.created_at ?? null

    for (const a of activity) {
      if (oldestLoaded && a.created_at < oldestLoaded) continue
      items.push({ kind: 'activity', id: `a-${a.id}`, created_at: a.created_at, activity: a })
    }

    return items.sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0))
  })()


  // All currently loaded threads, not just the post-filter `visible` list
  // below — cheaper to over-fetch a few extra rows' indicators than to
  // recompute this every time onlyUnread/showClosed toggles.
  const leadIds = threads.map((t) => t.leads?.id).filter((id): id is string => Boolean(id))
  const leadIndicators = useLeadIndicators(leadIds)
  const aiPausedByThread = useAiPausedThreads(threads.map((t) => t.id))

  return (
    <div className="page fade-in page-workspace">
      <div className="page-header">
        <div>
          <h1 className="page-title">Чати</h1>
          <p className="page-description">Всі треди з підключених каналів</p>
        </div>
      </div>

      {threadsLoading ? (
        <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
      ) : threadsError ? (
        <div className="alert alert-error">{threadsError}</div>
      ) : threads.length === 0 ? (
        <div className="empty-state">
          <Marquee />
          <span className="empty-state-icon">
            <IconChat size={22} />
          </span>
          <h3>Поки немає лідів</h3>
          <p>Коли клієнти напишуть у підключений канал, їхні треди з&rsquo;являться тут.</p>
        </div>
      ) : (
        <div className="chats-layout">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignSelf: 'flex-start' }}>
              <button
                type="button"
                className={`btn ${onlyUnread ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setOnlyUnread((v) => !v)}
              >
                Тільки непрочитані
              </button>
              <button
                type="button"
                className={`btn ${showClosed ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setShowClosed((v) => !v)}
              >
                Показати закриті
              </button>
            </div>

            <div
              className="card card-tight thread-list"
              onScroll={(e) => {
                const el = e.currentTarget
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) loadMoreThreads()
              }}
            >
              {(() => {
                // Archived leads never show here — archive now lives only in
                // CRM's own Archive tab, no toggle back to visibility from
                // Chats. Blocked leads are deliberately absent from both
                // filters — they stay exactly as visible as any other thread,
                // only marked. This is presentation only, applied after the
                // paginated fetch above, so the cursor/realtime logic that
                // built `threads` is untouched.
                //
                // «Показати закриті» switches between two disjoint lists
                // rather than widening one: off shows only open threads, on
                // shows only closed ones. Previously "on" fell through to
                // everything, which read as the toggle doing nothing.
                const statusFiltered = threads.filter((t) => {
                  if (t.leads?.status === 'archived') return false
                  return showClosed ? t.status === 'closed' : t.status !== 'closed'
                })
                const visible = onlyUnread ? statusFiltered.filter((t) => t.unread_count > 0) : statusFiltered

                if (visible.length === 0) {
                  return (
                    <p style={{ color: 'var(--fg-muted)', fontSize: '0.8125rem', textAlign: 'center', padding: '1rem' }}>
                      Нічого не знайдено за поточним фільтром.
                    </p>
                  )
                }

                return visible.map((thread) => {
                  const last = thread.messages[0] ?? null
                  const leadStatus = thread.leads?.status
                  return (
                    // A plain div wrapper, not another button: the reopen
                    // button below sits next to this row's own <button> as a
                    // sibling on purpose — nesting a second interactive
                    // control inside a <button> is invalid HTML and silently
                    // drops its clicks (see QuickReplyPicker's nested-<form>
                    // bug fixed earlier — same class of issue).
                    <div key={thread.id} className="thread-item-row">
                    <button
                      type="button"
                      className={`thread-item${thread.id === selectedId ? ' active' : ''}${leadStatus === 'blocked' ? ' thread-item-blocked' : ''}`}
                      onClick={() => selectThread(thread.id)}
                    >
                      <span className="thread-avatar">{leadLabel(thread.leads).slice(0, 1).replace('@', '')}</span>
                      <span className="thread-item-body">
                        <span className="thread-item-top">
                          <span className="thread-item-name">{leadLabel(thread.leads)}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3125rem', flexShrink: 0 }}>
                            {thread.leads && <LeadIndicatorIcons entry={leadIndicators[thread.leads.id]} />}
                            {aiPausedByThread[thread.id] && aiPausedByThread[thread.id].length > 0 && (
                              <HoverTooltip
                                content={
                                  <div className="hover-tooltip-tasks">
                                    <div className="hover-tooltip-label">
                                      <IconCpu size={11} />
                                      AI зупинено
                                    </div>
                                    {aiPausedByThread[thread.id].map((info, i) => (
                                      <div className="hover-tooltip-task-row" key={i}>
                                        <span className="hover-tooltip-task-title">
                                          {info.funnelName} → {info.nodeLabel}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                }
                              >
                                <span className="lead-indicator-icon lead-indicator-ai-paused" aria-label="AI зупинено менеджером">
                                  <IconCpu size={12} />
                                </span>
                              </HoverTooltip>
                            )}
                          </span>
                          <span className="thread-item-time">{formatThreadListTime(last?.created_at ?? thread.created_at)}</span>
                        </span>
                        <span className="thread-item-preview">{last?.body ?? '—'}</span>
                      </span>
                      {leadStatus === 'blocked' && <span className="badge badge-danger">Заблокований</span>}
                      {leadStatus === 'archived' && <span className="badge badge-neutral">Архів</span>}
                      {thread.unread_count > 0 && <span className="badge badge-success">{thread.unread_count}</span>}
                    </button>
                    {thread.status === 'closed' && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-icon thread-item-reopen"
                        disabled={reopeningThreadId === thread.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleListReopenThread(thread.id)
                        }}
                        title="Відкрити чат"
                        aria-label="Відкрити чат"
                      >
                        {reopeningThreadId === thread.id ? <IconSpinner size={13} /> : <IconInbox size={13} />}
                      </button>
                    )}
                    </div>
                  )
                })
              })()}
              {threadsLoadingMore && (
                <p style={{ color: 'var(--fg-muted)', fontSize: '0.8125rem', textAlign: 'center', padding: '0.5rem' }}>
                  Завантаження…
                </p>
              )}
            </div>
          </div>

          <div className="card thread-detail">
            {!selectedThread ? (
              <div className="empty-state" style={{ border: 'none', background: 'transparent', flex: 1 }}>
                <span className="empty-state-icon">
                  <IconChat size={22} />
                </span>
                <h3>Оберіть тред</h3>
                <p>Виберіть діалог зі списку, щоб побачити історію повідомлень.</p>
              </div>
            ) : (
              <>
                <div className="thread-detail-header">
                  <span className="thread-avatar">{leadLabel(selectedThread.leads).slice(0, 1).replace('@', '')}</span>
                  <div className="thread-detail-identity">
                    <div className="thread-item-name">
                      {leadLabel(selectedThread.leads)}
                      {selectedThread.leads?.status === 'blocked' && (
                        <span className="badge badge-danger" style={{ marginLeft: '0.5rem' }}>
                          Заблокований
                        </span>
                      )}
                      {selectedThread.leads?.status === 'archived' && (
                        <span className="badge badge-neutral" style={{ marginLeft: '0.5rem' }}>
                          Архів
                        </span>
                      )}
                      {selectedThread.status === 'closed' && (
                        <span className="badge badge-neutral" style={{ marginLeft: '0.5rem' }}>
                          Закрито
                        </span>
                      )}
                    </div>
                    <div className="settings-row-hint" style={{ marginTop: 0 }}>
                      {selectedThread.channel_type}
                    </div>
                  </div>

                  <div className="thread-detail-actions">
                    <button
                      type="button"
                      className={`btn btn-icon ${profileOpen ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setProfileOpen((v) => !v)}
                      title="Профіль"
                      aria-label="Профіль"
                      aria-pressed={profileOpen}
                    >
                      <IconUser size={15} />
                    </button>
                    {selectedThread.leads && selectedThread.leads.status !== 'blocked' && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-icon"
                        disabled={headerActionPending !== null}
                        onClick={() => handleHeaderBlock(selectedThread.leads!)}
                        title="Заблокувати"
                        aria-label="Заблокувати"
                      >
                        {headerActionPending === 'blocked' ? <IconSpinner size={15} /> : <IconBan size={15} />}
                      </button>
                    )}
                    {selectedThread.leads && selectedThread.leads.status !== 'archived' && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-icon"
                        disabled={headerActionPending !== null}
                        onClick={() => handleHeaderArchive(selectedThread.leads!)}
                        title="Архівувати"
                        aria-label="Архівувати"
                      >
                        {headerActionPending === 'archived' ? <IconSpinner size={15} /> : <IconArchiveBox size={15} />}
                      </button>
                    )}
                    {selectedThread.status !== 'closed' ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-icon"
                        disabled={headerActionPending !== null}
                        onClick={() => void handleHeaderCloseThread(selectedThread.id)}
                        title="Закрити"
                        aria-label="Закрити"
                      >
                        {headerActionPending === 'closed' ? <IconSpinner size={15} /> : <IconClose size={15} />}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary btn-icon"
                        disabled={headerActionPending !== null}
                        onClick={() => void handleHeaderOpenThread(selectedThread.id)}
                        title="Відкрити чат"
                        aria-label="Відкрити чат"
                      >
                        {headerActionPending === 'opened' ? <IconSpinner size={15} /> : <IconInbox size={15} />}
                      </button>
                    )}
                  </div>
                </div>

                {headerActionError && (
                  <div className="alert alert-error" style={{ marginBottom: '0.75rem' }}>
                    {headerActionError}
                  </div>
                )}

                <div
                  className="message-list"
                  ref={messageListRef}
                  onScroll={(e) => {
                    if (e.currentTarget.scrollTop < 80) loadOlderMessages()
                  }}
                >
                  {messagesLoading ? (
                    <p style={{ color: 'var(--fg-muted)' }}>Завантаження…</p>
                  ) : (
                    <>
                      {messagesLoadingMore && (
                        <p style={{ color: 'var(--fg-muted)', fontSize: '0.8125rem', textAlign: 'center' }}>
                          Завантаження…
                        </p>
                      )}
                      {feedItems.map((item, index) => {
                        const prev = index > 0 ? feedItems[index - 1] : null
                        const showDate = !prev || !isSameDay(prev.created_at, item.created_at)

                        if (item.kind === 'activity') {
                          const entry = item.activity
                          return (
                            <div key={item.id}>
                              {showDate && (
                                <div className="feed-divider feed-divider-date">
                                  <span>{formatDayLabel(item.created_at)}</span>
                                </div>
                              )}
                              <div className={`feed-system-marker feed-activity ${activityTone(entry.action_type)}`}>
                                <span>
                                  {activityText(entry)} <em>— {activityActor(entry)}</em>
                                </span>
                                <span className="message-time">{formatMessageTime(entry.created_at)}</span>
                              </div>
                            </div>
                          )
                        }

                        const message = item.message
                        const showUnread = firstUnreadId === message.id
                        const meta = (message.meta ?? null) as MessageMeta | null
                        return (
                          <div key={item.id}>
                            {showDate && (
                              <div className="feed-divider feed-divider-date">
                                <span>{formatDayLabel(message.created_at)}</span>
                              </div>
                            )}
                            {showUnread && (
                              <div className="feed-divider feed-divider-unread" ref={firstUnreadRef}>
                                <span>Нові повідомлення</span>
                              </div>
                            )}
                            {meta?.type === 'lgt_start' ? (
                              <div className="feed-system-block">
                                <IconLink size={13} aria-hidden="true" />
                                <span>
                                  Перейшов за посиланням <strong>{meta.link_name ?? '—'}</strong>
                                  {meta.funnel_name ? <> → воронка <strong>{meta.funnel_name}</strong></> : null}
                                </span>
                                <span className="message-time">{formatMessageTime(message.created_at)}</span>
                              </div>
                            ) : meta?.type === 'stale_button_click' ? (
                              // Kept in the transcript so a manager can see the
                              // lead did tap something, but visibly inert — the
                              // funnel deliberately ignored it.
                              <div className="feed-system-marker is-muted">
                                <span>↺ повторне натискання застарілої кнопки — проігноровано</span>
                                <span className="message-time">{formatMessageTime(message.created_at)}</span>
                              </div>
                            ) : meta?.type === 'button_click' ? (
                              <div className="feed-system-marker is-button-click">
                                <span>→ натиснув «{meta.label ?? message.body}»</span>
                                <span className="message-time">{formatMessageTime(message.created_at)}</span>
                              </div>
                            ) : (
                              <div
                                className={`message-bubble ${message.direction}${message.sender === 'ai' ? ' is-ai' : ''}`}
                              >
                                {(meta?.attachments ?? []).map((att, i) => (
                                  <AttachmentView key={`${att.url}-${i}`} attachment={att} onZoom={setZoomedImage} />
                                ))}
                                {message.body}
                                {/* Under the player, never instead of it: the
                                    transcript is an aid, the recording is the
                                    message. */}
                                {hasVoice(meta) &&
                                  (message.transcript ? (
                                    <span className="msg-transcript">{message.transcript}</span>
                                  ) : (
                                    <span className="msg-transcript is-pending">Розшифровується…</span>
                                  ))}
                                <span className="message-time">{formatMessageTime(message.created_at)}</span>
                                {/* Readonly on purpose: these are the buttons
                                    rendered inside Telegram/WhatsApp, and only
                                    the lead can act on them. */}
                                {(meta?.buttons ?? []).length > 0 && (
                                  <div className="msg-buttons">
                                    {meta!.buttons!.map((b, i) => (
                                      <span key={b.id ?? i} className="msg-button-pill">
                                        {b.actionType === 'link' && <IconLink size={11} aria-hidden="true" />}
                                        {b.label ?? '—'}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </>
                  )}
                </div>

                {replyError && (
                  <div className="alert alert-error" style={{ marginTop: '1rem' }}>
                    {replyError}
                  </div>
                )}

                {attachError && (
                  <div className="alert alert-error" style={{ marginTop: '1rem' }}>
                    {attachError}
                  </div>
                )}

                {attachDraft && (
                  <div className="attach-draft-preview">
                    {attachDraft.type === 'photo' ? (
                      <img className="attach-draft-thumb" src={attachDraft.url} alt={attachDraft.filename} />
                    ) : (
                      <span className="attach-draft-file">
                        <IconFile size={15} aria-hidden="true" />
                        <span>{attachDraft.filename}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn-icon-ghost"
                      onClick={() => setAttachDraft(null)}
                      aria-label="Прибрати прикріплений файл"
                      title="Прибрати"
                    >
                      <IconClose size={13} />
                    </button>
                  </div>
                )}

                <form className="reply-box" onSubmit={handleReplySubmit}>
                  <QuickReplyPicker onInsert={(text) => setReply(text)} />
                  <input
                    ref={attachInputRef}
                    type="file"
                    className="attach-file-input"
                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void handleAttachFile(file)
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    onClick={() => attachInputRef.current?.click()}
                    disabled={attachUploading}
                    title="Прикріпити файл"
                    aria-label="Прикріпити файл"
                  >
                    {attachUploading ? <IconSpinner size={16} /> : <IconPaperclip size={16} />}
                  </button>
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Написати відповідь…"
                    disabled={sending}
                  />
                  <button type="submit" className="btn btn-primary" disabled={(!reply.trim() && !attachDraft) || sending}>
                    {sending ? <IconSpinner size={16} /> : 'Надіслати'}
                  </button>
                </form>

                {profileOpen && selectedThread.leads && (
                  <>
                    <div className="profile-drawer-backdrop" onClick={() => setProfileOpen(false)} />
                    <aside className="profile-drawer" role="dialog" aria-label="Профіль ліда">
                      <LeadProfile
                        leadId={selectedThread.leads.id}
                        threadId={selectedThread.id}
                        onClose={() => setProfileOpen(false)}
                        onLeadStatusChange={handleLeadStatusChange}
                        onThreadClosed={handleThreadClosed}
                        onThreadOpened={handleThreadOpened}
                        onDeleted={handleLeadDeleted}
                      />
                    </aside>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Portalled like the other modals, so the chat panel's own scroll
          containers can't clip or offset it. */}
      {zoomedImage &&
        createPortal(
          <div className="modal-backdrop lightbox-backdrop" onClick={() => setZoomedImage(null)}>
            <img className="lightbox-image" src={zoomedImage} alt="Зображення на весь розмір" />
          </div>,
          document.body,
        )}
    </div>
  )
}
