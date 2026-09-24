import { useEffect, useState } from 'react'
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
 * Read-only and independent of LeadProfile.tsx — it doesn't know this hook
 * exists, and this hook doesn't call any of its save/update logic. A task or
 * note edited inside an open LeadProfile panel won't retroactively refresh
 * an indicator already rendered elsewhere until the underlying leadIds list
 * changes (new page, filter change, remount) — same isolation boundary the
 * rest of the indicator feature keeps.
 */
export function useLeadIndicators(leadIds: string[]): Record<string, LeadIndicatorEntry> {
  const [data, setData] = useState<Record<string, LeadIndicatorEntry>>({})

  // Stable key: callers typically derive leadIds inline on every render
  // (e.g. threads.map(...)), which is a new array identity each time even
  // when the actual ids are unchanged — sorting+joining collapses that to a
  // primitive the effect can dedupe on.
  const key = leadIds.length > 0 ? Array.from(new Set(leadIds)).sort().join(',') : ''

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

  return data
}
