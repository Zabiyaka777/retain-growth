import { useEffect, useState } from 'react'
import type { RealtimePostgresInsertPayload } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { getActiveThreadId } from '../lib/activeThread'
import { playNotificationSound } from '../lib/notificationSound'

interface MessageInsertPayload {
  id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
}

/**
 * App-wide chat notifications for the sidebar: how many threads have unread
 * messages, plus the blip that plays when a new inbound message arrives in a
 * thread the agent isn't currently reading.
 *
 * Counts threads, not messages — "3" next to Чати means three conversations
 * need attention, which is the number a person acts on; a message total would
 * spike to 12 the moment one lead sends a dozen lines.
 *
 * Independent of Chats.tsx: its own channels, its own count query. It never
 * writes thread state, so the page's Realtime/pagination logic is untouched.
 */
export function useChatNotifications(): number {
  const [orgId, setOrgId] = useState<string | null>(null)
  const [unreadThreads, setUnreadThreads] = useState(0)

  useEffect(() => {
    let cancelled = false

    supabase.auth
      .getUser()
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

  useEffect(() => {
    if (!orgId) return
    let cancelled = false

    // Re-counted server-side on every threads change rather than tracked
    // incrementally here: the count then can't drift out of sync with what
    // the webhook and mark-thread-read do to unread_count.
    async function refreshCount() {
      const { count, error } = await supabase
        .from('threads')
        .select('id', { count: 'exact', head: true })
        .gt('unread_count', 0)
      if (cancelled) return
      if (!error) setUnreadThreads(count ?? 0)
    }

    void refreshCount()

    const channel = supabase
      .channel(`sidebar-unread-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'threads', filter: `org_id=eq.${orgId}` }, () => {
        void refreshCount()
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [orgId])

  useEffect(() => {
    if (!orgId) return

    const channel = supabase
      .channel(`sidebar-sound-${orgId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` },
        (payload: RealtimePostgresInsertPayload<MessageInsertPayload>) => {
          const row = payload.new
          if (row.direction !== 'inbound') return
          // Silent while the agent is looking at that very conversation —
          // they can already see the message arrive.
          if (getActiveThreadId() === row.thread_id) return
          playNotificationSound()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orgId])

  return unreadThreads
}
