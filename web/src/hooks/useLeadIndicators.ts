import { useEffect, useRef, useState } from 'react'
import type { RealtimePostgresChangesPayload, RealtimePostgresUpdatePayload } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'

export interface LeadTaskIndicator {
  id: string
  title: string
  deadline: string | null
}

export interface LeadIndicatorEntry {
  tasks: LeadTaskIndicator[]
  hasOverdueTask: boolean
  notes: string | null
  blockedBot: boolean
}

/**
 * Batch-loads the "does this lead have open tasks / saved notes" signal for
 * a whole visible list at once — two queries total (lead_tasks, leads),
 * scoped with .in(), regardless of list size. Never one query per row: a
 * per-row fetch here would turn a 20-30 row page (Chats' thread list, CRM's
 * table) into 20-30x that many requests.
 *
 * Stays live after the initial load: a second effect subscribes to
 * lead_tasks and leads over Realtime and patches the affected entry locally
 * (no refetch), so completing a task or a bot block landing via
 * my_chat_member updates the badge without a page refresh. Still independent
 * of LeadProfile.tsx — it doesn't know this hook exists; the database is the
 * only channel between them.
 */
export function useLeadIndicators(leadIds: string[]): Record<string, LeadIndicatorEntry> {
  const [data, setData] = useState<Record<string, LeadIndicatorEntry>>({})

  // Stable key: callers typically derive leadIds inline on every render
  // (e.g. threads.map(...)), which is a new array identity each time even
  // when the actual ids are unchanged — sorting+joining collapses that to a
  // primitive the effect can dedupe on.
  const key = leadIds.length > 0 ? Array.from(new Set(leadIds)).sort().join(',') : ''

  // Read by the realtime handlers below so the subscription can stay open
  // across list changes instead of being torn down on every page/filter switch.
  const idsRef = useRef<Set<string>>(new Set())
  idsRef.current = new Set(key ? key.split(',') : [])

  useEffect(() => {
    if (!key) {
      setData({})
      return
    }
    const ids = key.split(',')

    let cancelled = false

    async function load() {
      const [tasksRes, leadsRes] = await Promise.all([
        supabase.from('lead_tasks').select('id, lead_id, title, deadline').eq('completed', false).in('lead_id', ids),
        supabase.from('leads').select('id, manager_notes, blocked_bot').in('id', ids),
      ])

      if (cancelled) return

      const next: Record<string, LeadIndicatorEntry> = {}
      const now = Date.now()

      function entryFor(id: string) {
        return next[id] ?? (next[id] = { tasks: [], hasOverdueTask: false, notes: null, blockedBot: false })
      }

      if (!tasksRes.error && tasksRes.data) {
        for (const row of tasksRes.data as { id: string; lead_id: string; title: string; deadline: string | null }[]) {
          const entry = entryFor(row.lead_id)
          entry.tasks.push({ id: row.id, title: row.title, deadline: row.deadline })
          if (row.deadline && new Date(row.deadline).getTime() < now) entry.hasOverdueTask = true
        }
      }

      if (!leadsRes.error && leadsRes.data) {
        for (const row of leadsRes.data as { id: string; manager_notes: string | null; blocked_bot: boolean }[]) {
          if ((!row.manager_notes || !row.manager_notes.trim()) && !row.blocked_bot) continue
          const entry = entryFor(row.id)
          if (row.manager_notes && row.manager_notes.trim()) entry.notes = row.manager_notes
          entry.blockedBot = row.blocked_bot
        }
      }

      if (!cancelled) setData(next)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [key])

  // Events are unfiltered on purpose: RLS already limits INSERT/UPDATE to the
  // caller's org, and postgres_changes can't filter DELETE at all (old row is
  // PK-only). Anything for a lead that isn't currently on screen is dropped.
  useEffect(() => {
    const channel = supabase
      .channel(`lead-indicators-${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lead_tasks' },
        (payload: RealtimePostgresChangesPayload<LeadTaskRow>) => {
          if (payload.eventType === 'DELETE') {
            const goneId = (payload.old as Partial<LeadTaskRow>).id
            if (!goneId) return
            setData((prev) => {
              let changed = false
              const next: Record<string, LeadIndicatorEntry> = {}
              for (const [leadId, entry] of Object.entries(prev)) {
                if (entry.tasks.some((t) => t.id === goneId)) {
                  changed = true
                  next[leadId] = withTasks(entry, entry.tasks.filter((t) => t.id !== goneId))
                } else {
                  next[leadId] = entry
                }
              }
              return changed ? next : prev
            })
            return
          }

          const row = payload.new
          if (!idsRef.current.has(row.lead_id)) return
          setData((prev) => {
            const entry = prev[row.lead_id] ?? emptyEntry()
            const others = entry.tasks.filter((t) => t.id !== row.id)
            // A completed task leaves the badge; an open one (new, or edited
            // title/deadline) replaces any earlier copy of itself.
            const tasks = row.completed ? others : [...others, { id: row.id, title: row.title, deadline: row.deadline }]
            return { ...prev, [row.lead_id]: withTasks(entry, tasks) }
          })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'leads' },
        (payload: RealtimePostgresUpdatePayload<LeadRow>) => {
          const row = payload.new
          if (!idsRef.current.has(row.id)) return
          setData((prev) => {
            const entry = prev[row.id] ?? emptyEntry()
            // Unchanged TOASTed columns can be absent from the payload — only
            // overwrite what the event actually carries.
            const notes = 'manager_notes' in row ? (row.manager_notes?.trim() ? row.manager_notes : null) : entry.notes
            const blockedBot = 'blocked_bot' in row ? !!row.blocked_bot : entry.blockedBot
            return { ...prev, [row.id]: { ...entry, notes, blockedBot } }
          })
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  return data
}

interface LeadTaskRow {
  id: string
  lead_id: string
  title: string
  deadline: string | null
  completed: boolean
}

interface LeadRow {
  id: string
  manager_notes: string | null
  blocked_bot: boolean
}

function emptyEntry(): LeadIndicatorEntry {
  return { tasks: [], hasOverdueTask: false, notes: null, blockedBot: false }
}

function withTasks(entry: LeadIndicatorEntry, tasks: LeadTaskIndicator[]): LeadIndicatorEntry {
  const now = Date.now()
  return {
    ...entry,
    tasks,
    hasOverdueTask: tasks.some((t) => t.deadline !== null && new Date(t.deadline).getTime() < now),
  }
}
