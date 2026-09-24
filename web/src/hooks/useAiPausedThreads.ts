import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export interface AiPausedInfo {
  funnelName: string
  nodeLabel: string
}

// Same fallback labels LeadProfile.tsx's own nodeLabel() uses — kept as a
// separate small copy here rather than a shared import, since this hook's
// batching shape (thread-keyed, not lead-keyed) doesn't fit that file's
// per-row resolution helper anyway.
const NODE_TYPE_LABELS: Record<string, string> = {
  entry: 'Точка входу',
  message: 'Повідомлення',
  action: 'Дія',
  ai: 'AI',
  delay: 'Затримка',
  condition: 'Умова',
  conversion: 'Логічна конверсія',
}

interface StoppedStateRow {
  thread_id: string
  funnel_id: string
  funnel_node_id: string | null
}

interface FunnelRow {
  id: string
  name: string
}

interface FunnelNodeRow {
  id: string
  type: string
  config: { label?: string } | null
}

/**
 * Batch-loads "which funnels did pause-ai.ts stop on this thread" for a
 * whole visible thread list at once — same isolation and batching shape as
 * useLeadIndicators, just keyed by thread_id instead of lead_id (a stopped
 * funnel_states row belongs to a thread, not directly to a lead). Three
 * queries total (funnel_states, funnels, funnel_nodes), scoped with .in(),
 * regardless of list size.
 */
export function useAiPausedThreads(threadIds: string[]): Record<string, AiPausedInfo[]> {
  const [data, setData] = useState<Record<string, AiPausedInfo[]>>({})

  // Stable key for the same reason useLeadIndicators has one — callers
  // derive threadIds inline on every render, a new array identity each time.
  const key = threadIds.length > 0 ? Array.from(new Set(threadIds)).sort().join(',') : ''

  useEffect(() => {
    if (!key) {
      setData({})
      return
    }
    const ids = key.split(',')
    let cancelled = false

    async function load() {
      const { data: stateRows, error: stateError } = await supabase
        .from('funnel_states')
        .select('thread_id, funnel_id, funnel_node_id')
        .eq('status', 'stopped')
        .in('thread_id', ids)

      if (cancelled) return
      if (stateError || !stateRows || stateRows.length === 0) {
        setData({})
        return
      }

      const rows = stateRows as StoppedStateRow[]
      const funnelIds = Array.from(new Set(rows.map((r) => r.funnel_id)))

      const [funnelsRes, nodesRes] = await Promise.all([
        supabase.from('funnels').select('id, name').in('id', funnelIds),
        supabase.from('funnel_nodes').select('id, type, config').in('funnel_id', funnelIds),
      ])
      if (cancelled) return

      const funnelNames = new Map(((funnelsRes.data as FunnelRow[] | null) ?? []).map((f) => [f.id, f.name]))
      const nodes = new Map(((nodesRes.data as FunnelNodeRow[] | null) ?? []).map((n) => [n.id, n]))

      const next: Record<string, AiPausedInfo[]> = {}
      for (const row of rows) {
        const funnelName = funnelNames.get(row.funnel_id) ?? 'Воронку видалено'
        const node = row.funnel_node_id ? nodes.get(row.funnel_node_id) : undefined
        let nodeName = 'Вузол не визначено'
        if (node) {
          const custom = node.config?.label?.trim()
          const typeLabel = NODE_TYPE_LABELS[node.type] ?? node.type
          nodeName = custom ? `${custom} (${typeLabel})` : typeLabel
        }
        const list = next[row.thread_id] ?? (next[row.thread_id] = [])
        list.push({ funnelName, nodeLabel: nodeName })
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
