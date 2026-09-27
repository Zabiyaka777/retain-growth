import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { IconBell, IconCheckCircle, IconClose } from './icons'

interface NotificationRow {
  id: string
  source: string
  title: string
  body: string
  link_url: string | null
  created_at: string
  read_at: string | null
}

const LIST_LIMIT = 30

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

async function markRead(payload: { ids: string[] } | { all: true }) {
  const token = await getAccessToken()
  if (!token) return
  await fetch('/.netlify/functions/mark-notifications-read', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Best-effort: the row just stays unread and the next load shows it again.
  })
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'щойно'
  if (min < 60) return `${min} хв тому`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} год тому`
  const d = Math.floor(h / 24)
  if (d === 1) return 'вчора'
  if (d < 7) return `${d} дн тому`
  return new Date(iso).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })
}

// Sidebar bell: unread badge + a popover with the org's latest notifications
// (system checks from system-notifications-check.ts, admin broadcasts). Rows
// are SELECT-only for the client; marking read goes through
// mark-notifications-read. Live via Realtime, same as the Чати unread badge.
export default function NotificationsBell() {
  const navigate = useNavigate()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [items, setItems] = useState<NotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<React.CSSProperties>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(async ({ data }) => {
      if (cancelled || !data.user) return
      const { data: profile } = await supabase.from('profiles').select('org_id').eq('id', data.user.id).single()
      if (!cancelled && profile) setOrgId(profile.org_id as string)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async () => {
    const [list, count] = await Promise.all([
      supabase
        .from('notifications')
        .select('id, source, title, body, link_url, created_at, read_at')
        .order('created_at', { ascending: false })
        .limit(LIST_LIMIT),
      supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    ])
    if (!list.error) setItems((list.data ?? []) as NotificationRow[])
    if (!count.error) setUnread(count.count ?? 0)
  }, [])

  useEffect(() => {
    if (!orgId) return
    load()
    const channel = supabase
      .channel(`notifications-bell-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `org_id=eq.${orgId}` }, () => load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [orgId, load])

  // Anchored to the button, rendered into <body>: the sidebar clips overflow
  // and the collapsed rail is only 68px wide. Right of the rail on desktop;
  // under the top bar on the narrow (<=680px) layout.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    function place() {
      const r = btnRef.current!.getBoundingClientRect()
      if (window.innerWidth <= 680) setPos({ top: r.bottom + 8, right: 8, left: 8 })
      else setPos({ left: r.right + 12, bottom: Math.max(8, window.innerHeight - r.bottom) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function readLocally(ids: string[] | 'all') {
    const now = new Date().toISOString()
    setItems((prev) => prev.map((n) => (!n.read_at && (ids === 'all' || ids.includes(n.id)) ? { ...n, read_at: now } : n)))
    setUnread((u) => (ids === 'all' ? 0 : Math.max(0, u - ids.length)))
  }

  function handleItemClick(n: NotificationRow) {
    if (!n.read_at) {
      readLocally([n.id])
      markRead({ ids: [n.id] })
    }
    if (n.link_url) {
      if (n.link_url.startsWith('/')) {
        setOpen(false)
        navigate(n.link_url)
      } else {
        window.open(n.link_url, '_blank', 'noopener,noreferrer')
      }
    }
  }

  function handleReadAll() {
    readLocally('all')
    markRead({ all: true })
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sidebar-link sidebar-bell${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-label="Сповіщення"
        aria-label={unread > 0 ? `Сповіщення, ${unread} непрочитаних` : 'Сповіщення'}
      >
        <span className="sidebar-icon-wrap">
          <IconBell size={18} />
          {unread > 0 && (
            <span className="sidebar-unread-badge" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
        <span className="sidebar-link-label">Сповіщення</span>
      </button>

      {open &&
        createPortal(
          <div ref={popRef} className="notif-pop" style={pos} role="dialog" aria-label="Сповіщення">
            <div className="notif-pop-head">
              <span className="notif-pop-title">Сповіщення</span>
              {unread > 0 && (
                <button type="button" className="notif-readall" onClick={handleReadAll}>
                  <IconCheckCircle size={13} />
                  Позначити всі прочитаними
                </button>
              )}
              <button type="button" className="btn-icon-ghost" onClick={() => setOpen(false)} aria-label="Закрити">
                <IconClose size={14} />
              </button>
            </div>
            {items.length === 0 ? (
              <div className="notif-empty">
                <IconBell size={20} />
                <span>Поки що сповіщень немає</span>
              </div>
            ) : (
              <ul className="notif-list">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`notif-item${n.read_at ? '' : ' is-unread'}${n.link_url ? ' has-link' : ''}`}
                      onClick={() => handleItemClick(n)}
                    >
                      <span className="notif-dot" aria-hidden="true" />
                      <span className="notif-main">
                        <span className="notif-title">{n.title}</span>
                        {n.body && <span className="notif-body">{n.body}</span>}
                        <span className="notif-time">{timeAgo(n.created_at)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
