import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { IconArchiveBox, IconBan, IconBell, IconBellOff, IconCheckCircle, IconClose, IconInbox, IconSpinner, IconTrash } from './icons'

type LeadStatus = 'active' | 'blocked' | 'archived'
type ThreadStatus = 'open' | 'closed'

interface LeadCore {
  id: string
  username: string | null
  external_id: string
  status: LeadStatus
  created_at: string
  source_link_id: string | null
  manager_notes: string | null
  current_stage_id: string | null
  subscribed: boolean
}

interface TagRef {
  id: string
  name: string
}

interface LeadVariableRef {
  id: string
  label: string
  value: string | null
}

// Built-ins ("Підписка"/"Продажа") come back alongside the org's own custom
// stages — RLS decides which rows are visible, position orders them.
interface StageRef {
  id: string
  name: string
  is_locked: boolean
  position: number
}

interface VariableDefRef {
  id: string
  label: string
}

interface FunnelRef {
  id: string
  name: string
}

// A node's display name is its own label when the author gave it one, and
// falls back to the type — the builder leaves label empty by default.
interface FunnelNodeRef {
  id: string
  funnel_id: string
  type: string
  config: { label?: string } | null
}

interface FunnelStateRef {
  id: string
  funnel_id: string
  funnel_node_id: string | null
  status: string
}

const NODE_TYPE_LABELS: Record<string, string> = {
  entry: 'Точка входу',
  message: 'Повідомлення',
  action: 'Дія',
  ai: 'AI',
  delay: 'Затримка',
  condition: 'Умова',
  conversion: 'Логічна конверсія',
}

function nodeLabel(node: FunnelNodeRef): string {
  const custom = node.config?.label?.trim()
  const typeLabel = NODE_TYPE_LABELS[node.type] ?? node.type
  return custom ? `${custom} (${typeLabel})` : typeLabel
}

interface LeadSourceInfo {
  linkName: string
  params: Record<string, unknown>
}

interface LeadTask {
  id: string
  title: string
  deadline: string | null
  completed: boolean
  created_at: string
}

function leadLabel(lead: Pick<LeadCore, 'username' | 'external_id'> | null) {
  if (!lead) return 'Без імені'
  return lead.username ? `@${lead.username}` : lead.external_id
}

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

interface LeadProfileProps {
  leadId: string
  // Optional: the thread whose "Закрити" action this panel should expose.
  // Omit it (e.g. a lead with no thread yet) and the close-thread button
  // simply doesn't render.
  threadId?: string | null
  onClose?: () => void
  // Both fire only after the underlying API call succeeds, mirroring the
  // state update the caller would otherwise have done itself — lets Chats.tsx
  // and Crm.tsx each keep their own list/thread state in sync without this
  // component knowing anything about either one.
  onLeadStatusChange?: (leadId: string, status: 'blocked' | 'archived') => void
  onThreadClosed?: (threadId: string) => void
  // Symmetric counterpart — fires only after close-thread.ts succeeds with
  // action: 'open'.
  onThreadOpened?: (threadId: string) => void
  // Fires only after delete-lead.ts succeeds — the lead is gone from the
  // database at that point, so the caller (Chats.tsx/Crm.tsx) closes
  // whatever's showing this panel and drops the lead from its own lists.
  onDeleted?: (leadId: string) => void
}

export default function LeadProfile({ leadId, threadId, onClose, onLeadStatusChange, onThreadClosed, onThreadOpened, onDeleted }: LeadProfileProps) {
  const [lead, setLead] = useState<LeadCore | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [tags, setTags] = useState<TagRef[]>([])
  const [variables, setVariables] = useState<LeadVariableRef[]>([])
  const [source, setSource] = useState<LeadSourceInfo | null>(null)
  const [threadStatus, setThreadStatus] = useState<ThreadStatus | null>(null)

  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)

  const [tasks, setTasks] = useState<LeadTask[]>([])
  const [taskError, setTaskError] = useState<string | null>(null)
  const [taskPendingId, setTaskPendingId] = useState<string | null>(null)
  const [addingTask, setAddingTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskDeadline, setNewTaskDeadline] = useState('')

  // A lead can be enrolled in several funnels at once — each row here is one
  // funnel_states row, independent of the others (see manage-lead-funnel.ts:
  // every action already addresses one specific stateId/funnelId, never "the"
  // state for the thread).
  const [funnelStates, setFunnelStates] = useState<FunnelStateRef[]>([])
  // Separate from funnelStates above: rows pause-ai.ts stopped (a manager's
  // manual reply won the thread) — shown as a badge next to the lead's own
  // status, never mixed into the active/ai_active list or its pickers.
  const [stoppedFunnelStates, setStoppedFunnelStates] = useState<FunnelStateRef[]>([])
  // 'completed' rows: the walk reached a node with no way out. Without these
  // a lead who went through a whole branch looked like one never enrolled —
  // and got re-attached "because the block is empty". Shown muted, read-only.
  const [completedFunnelStates, setCompletedFunnelStates] = useState<FunnelStateRef[]>([])
  const [funnels, setFunnels] = useState<FunnelRef[]>([])
  const [funnelNodes, setFunnelNodes] = useState<FunnelNodeRef[]>([])
  // Which row is mid-request — a state.id, or 'attach' for the "add funnel"
  // form — so one row's spinner never disables the others.
  const [funnelBusyId, setFunnelBusyId] = useState<string | null>(null)
  const [funnelError, setFunnelError] = useState<string | null>(null)
  // Per-row "move to node" draft, keyed by funnel_states.id.
  const [moveNodeDrafts, setMoveNodeDrafts] = useState<Record<string, string>>({})
  const [showAttachForm, setShowAttachForm] = useState(false)
  const [attachFunnelDraft, setAttachFunnelDraft] = useState('')
  const [attachNodeDraft, setAttachNodeDraft] = useState('')
  // "Увімкнути AI": which stopped state the confirm dialog is about (null =
  // closed), and a one-line outcome shown next to the badge afterwards.
  const [resumeTarget, setResumeTarget] = useState<FunnelStateRef | null>(null)
  const [resumeBusy, setResumeBusy] = useState(false)
  const [resumeNotice, setResumeNotice] = useState<string | null>(null)

  const [actionPending, setActionPending] = useState<'blocked' | 'archived' | 'closed' | 'subscription' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // ---- Stage / editable tags / editable variables ----
  const [stages, setStages] = useState<StageRef[]>([])
  const [stageDraft, setStageDraft] = useState('')
  const [stageValueDraft, setStageValueDraft] = useState('')
  const [stageSaving, setStageSaving] = useState(false)
  const [stageSaved, setStageSaved] = useState(false)
  const [stageError, setStageError] = useState<string | null>(null)

  const [allTags, setAllTags] = useState<TagRef[]>([])
  const [tagPendingId, setTagPendingId] = useState<string | null>(null)
  const [tagError, setTagError] = useState<string | null>(null)

  const [allVariableDefs, setAllVariableDefs] = useState<VariableDefRef[]>([])
  // Per-variable edit buffers, keyed by variable_def_id — an entry exists
  // only while that row is being edited, so untouched rows keep rendering
  // straight from `variables`.
  const [variableDrafts, setVariableDrafts] = useState<Record<string, string>>({})
  const [variablePendingId, setVariablePendingId] = useState<string | null>(null)
  const [variableError, setVariableError] = useState<string | null>(null)

  // Fetches its own copy of everything a caller could show — the base lead
  // row included — so Chats.tsx and Crm.tsx only ever need to pass a
  // leadId/threadId, never pre-shape their own data into this component.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    setActionError(null)

    async function load() {
      const [
        leadRes,
        tagsRes,
        varsRes,
        threadRes,
        tasksRes,
        stagesRes,
        allTagsRes,
        allDefsRes,
        funnelStateRes,
        stoppedFunnelStateRes,
        completedFunnelStateRes,
        funnelsRes,
        funnelNodesRes,
      ] = await Promise.all([
        supabase
          .from('leads')
          .select('id, username, external_id, status, created_at, source_link_id, manager_notes, current_stage_id, subscribed')
          .eq('id', leadId)
          .single(),
        supabase.from('lead_tags').select('tag_id, tags ( name )').eq('lead_id', leadId),
        supabase.from('lead_variables').select('variable_def_id, value, variable_defs ( label )').eq('lead_id', leadId),
        threadId ? supabase.from('threads').select('status').eq('id', threadId).maybeSingle() : Promise.resolve({ data: null, error: null }),
        supabase
          .from('lead_tasks')
          .select('id, title, deadline, completed, created_at')
          .eq('lead_id', leadId)
          .order('completed', { ascending: true })
          .order('deadline', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: true }),
        // The org's catalogs, needed for the pickers rather than for display:
        // stages to move the lead between, plus every tag/variable that could
        // be attached to it.
        supabase.from('funnel_stages').select('id, name, is_locked, position').order('position'),
        supabase.from('tags').select('id, name').order('name'),
        supabase.from('variable_defs').select('id, label').order('label'),
        // Funnel block: every active state on this thread, plus the catalogs
        // the pickers need. A thread can carry one funnel_states row per
        // funnel (unique(thread_id, funnel_id)) — since funnels no longer
        // have to be mutually exclusive, that can be several rows at once. A
        // lead with no thread simply has nothing to show here.
        threadId
          ? supabase
              .from('funnel_states')
              .select('id, funnel_id, funnel_node_id, status')
              .eq('thread_id', threadId)
              .in('status', ['active', 'ai_active'])
              .order('created_at', { ascending: true })
          : Promise.resolve({ data: null, error: null }),
        // Same shape, just 'stopped' — pause-ai.ts's own doing (a manager's
        // manual reply), surfaced as a badge rather than folded into the
        // list above so it never shows up in the move/stop pickers.
        threadId
          ? supabase
              .from('funnel_states')
              .select('id, funnel_id, funnel_node_id, status')
              .eq('thread_id', threadId)
              .eq('status', 'stopped')
              .order('created_at', { ascending: true })
          : Promise.resolve({ data: null, error: null }),
        // And 'completed' — the lead reached the end of a branch. Its own
        // muted list, so a finished funnel is visible rather than looking
        // like the lead was never in it.
        threadId
          ? supabase
              .from('funnel_states')
              .select('id, funnel_id, funnel_node_id, status')
              .eq('thread_id', threadId)
              .eq('status', 'completed')
              .order('created_at', { ascending: true })
          : Promise.resolve({ data: null, error: null }),
        supabase.from('funnels').select('id, name').order('name'),
        supabase.from('funnel_nodes').select('id, funnel_id, type, config'),
      ])

      if (cancelled) return

      if (leadRes.error || !leadRes.data) {
        setLoadError(true)
        setLoading(false)
        return
      }

      const row = leadRes.data as LeadCore
      setLead(row)
      setNotesDraft(row.manager_notes ?? '')
      setStageDraft(row.current_stage_id ?? '')

      if (!stagesRes.error && stagesRes.data) setStages(stagesRes.data as StageRef[])
      if (!funnelsRes.error && funnelsRes.data) setFunnels(funnelsRes.data as FunnelRef[])
      if (!funnelNodesRes.error && funnelNodesRes.data) setFunnelNodes(funnelNodesRes.data as FunnelNodeRef[])
      if (!funnelStateRes.error) {
        const rows = (funnelStateRes.data as FunnelStateRef[] | null) ?? []
        setFunnelStates(rows)
        setMoveNodeDrafts(Object.fromEntries(rows.map((r) => [r.id, r.funnel_node_id ?? ''])))
      }
      if (!stoppedFunnelStateRes.error) {
        setStoppedFunnelStates((stoppedFunnelStateRes.data as FunnelStateRef[] | null) ?? [])
      }
      if (!completedFunnelStateRes.error) {
        setCompletedFunnelStates((completedFunnelStateRes.data as FunnelStateRef[] | null) ?? [])
      }
      if (!allTagsRes.error && allTagsRes.data) setAllTags(allTagsRes.data as TagRef[])
      if (!allDefsRes.error && allDefsRes.data) setAllVariableDefs(allDefsRes.data as VariableDefRef[])

      if (!tagsRes.error && tagsRes.data) {
        setTags(
          (tagsRes.data as unknown as { tag_id: string; tags: { name: string } | null }[])
            .filter((r) => r.tags)
            .map((r) => ({ id: r.tag_id, name: r.tags!.name })),
        )
      }

      if (!varsRes.error && varsRes.data) {
        setVariables(
          (
            varsRes.data as unknown as {
              variable_def_id: string
              value: string | null
              variable_defs: { label: string } | null
            }[]
          )
            .filter((r) => r.variable_defs)
            .map((r) => ({ id: r.variable_def_id, label: r.variable_defs!.label, value: r.value })),
        )
      }

      if (threadId && !threadRes.error && threadRes.data) {
        setThreadStatus((threadRes.data as { status: ThreadStatus }).status)
      }

      if (!tasksRes.error && tasksRes.data) {
        setTasks(tasksRes.data as LeadTask[])
      }

      // Same proxy as before: captured_params lives on link_clicks (one row
      // per click, no FK to the lead), so the most recent click on the same
      // link is the closest available stand-in for "what this lead came from".
      if (row.source_link_id) {
        const { data: linkData, error: linkError } = await supabase
          .from('lead_gen_links')
          .select('name')
          .eq('id', row.source_link_id)
          .maybeSingle()
        if (cancelled) return

        if (!linkError && linkData) {
          const { data: clickData } = await supabase
            .from('link_clicks')
            .select('captured_params')
            .eq('link_id', row.source_link_id)
            .order('clicked_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (cancelled) return
          setSource({
            linkName: (linkData as { name: string }).name,
            params: (clickData?.captured_params as Record<string, unknown> | null) ?? {},
          })
        }
      }

      setLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [leadId, threadId])

  // One funnel_states row as it stands now → where it belongs in this card:
  // the active/ai_active list, the stopped badge, or the completed list.
  // Shared by Realtime and by this component's own actions, so a row can
  // never sit in both lists (e.g. a stopped row re-attached from here).
  const applyFunnelStateRow = useCallback((row: FunnelStateRef) => {
    const isLive = row.status === 'active' || row.status === 'ai_active'
    setFunnelStates((prev) => {
      const at = prev.findIndex((s) => s.id === row.id)
      if (!isLive) return at === -1 ? prev : prev.filter((s) => s.id !== row.id)
      if (at === -1) return [...prev, row]
      const next = prev.slice()
      next[at] = row
      return next
    })
    setStoppedFunnelStates((prev) => {
      const without = prev.filter((s) => s.id !== row.id)
      return row.status === 'stopped' ? [...without, row] : without.length === prev.length ? prev : without
    })
    setCompletedFunnelStates((prev) => {
      const without = prev.filter((s) => s.id !== row.id)
      return row.status === 'completed' ? [...without, row] : without.length === prev.length ? prev : without
    })
    // The move picker follows the row's node — unless the manager has
    // already picked a different target there and hasn't applied it yet.
    setMoveNodeDrafts((prev) => {
      if (!isLive) {
        if (!(row.id in prev)) return prev
        const next = { ...prev }
        delete next[row.id]
        return next
      }
      return { ...prev, [row.id]: prev[row.id] && prev[row.id] !== row.funnel_node_id ? prev[row.id] : (row.funnel_node_id ?? '') }
    })
  }, [])

  const removeFunnelStateRow = useCallback((id: string) => {
    setFunnelStates((prev) => (prev.some((s) => s.id === id) ? prev.filter((s) => s.id !== id) : prev))
    setStoppedFunnelStates((prev) => (prev.some((s) => s.id === id) ? prev.filter((s) => s.id !== id) : prev))
    setCompletedFunnelStates((prev) => (prev.some((s) => s.id === id) ? prev.filter((s) => s.id !== id) : prev))
  }, [])

  // The funnel/node catalogs are loaded once with the card; a funnel or node
  // created after that (another tab, the builder) would otherwise show up
  // here as "Воронку видалено". Read by the Realtime handler through refs so
  // the subscription doesn't reconnect whenever a catalog changes.
  const funnelsRef = useRef(funnels)
  funnelsRef.current = funnels
  const funnelNodesRef = useRef(funnelNodes)
  funnelNodesRef.current = funnelNodes
  const reloadCatalogs = useCallback(async () => {
    const [f, n] = await Promise.all([
      supabase.from('funnels').select('id, name').order('name'),
      supabase.from('funnel_nodes').select('id, funnel_id, type, config'),
    ])
    if (!f.error && f.data) setFunnels(f.data as FunnelRef[])
    if (!n.error && n.data) setFunnelNodes(n.data as FunnelNodeRef[])
  }, [])

  // Catch-up after a Realtime reconnect or the tab coming back: events in
  // between were never delivered, so read both lists fresh.
  const reloadFunnelStates = useCallback(async () => {
    if (!threadId) return
    const { data, error } = await supabase
      .from('funnel_states')
      .select('id, funnel_id, funnel_node_id, status')
      .eq('thread_id', threadId)
      .in('status', ['active', 'ai_active', 'stopped', 'completed'])
      .order('created_at', { ascending: true })
    if (error || !data) return
    const rows = data as FunnelStateRef[]
    const live = rows.filter((r) => r.status === 'active' || r.status === 'ai_active')
    setFunnelStates(live)
    setStoppedFunnelStates(rows.filter((r) => r.status === 'stopped'))
    setCompletedFunnelStates(rows.filter((r) => r.status === 'completed'))
    setMoveNodeDrafts((prev) => Object.fromEntries(live.map((r) => [r.id, prev[r.id] ?? r.funnel_node_id ?? ''])))
  }, [threadId])

  // Keeps the "Воронка" block live without a refetch — the graph advancing
  // on its own, a manual reply pausing AI (pause-ai.ts), move/stop/attach from
  // another tab. Same approach as useLeadIndicators: INSERT/UPDATE filtered to
  // this thread server-side; DELETE can't be filtered (the old row is PK-only)
  // so it's matched against the ids already on screen. RLS limits every event
  // to the caller's org.
  useEffect(() => {
    if (!threadId) return
    let hasSubscribed = false
    const onRow = (payload: RealtimePostgresChangesPayload<FunnelStateRef>) => {
      if (payload.eventType === 'DELETE') {
        const goneId = (payload.old as Partial<FunnelStateRef>).id
        if (goneId) removeFunnelStateRow(goneId)
        return
      }
      const row = payload.new
      applyFunnelStateRow({ id: row.id, funnel_id: row.funnel_id, funnel_node_id: row.funnel_node_id, status: row.status })
      const unknownFunnel = !funnelsRef.current.some((f) => f.id === row.funnel_id)
      const unknownNode = !!row.funnel_node_id && !funnelNodesRef.current.some((n) => n.id === row.funnel_node_id)
      if (unknownFunnel || unknownNode) void reloadCatalogs()
    }
    const channel = supabase
      .channel(`lead-profile-funnels-${threadId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'funnel_states', filter: `thread_id=eq.${threadId}` }, onRow)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'funnel_states', filter: `thread_id=eq.${threadId}` }, onRow)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'funnel_states' }, onRow)
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) void reloadFunnelStates()
        hasSubscribed = true
      })

    let timer: number | undefined
    function onVisibility() {
      if (document.visibilityState !== 'visible') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void reloadFunnelStates(), 400)
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      void supabase.removeChannel(channel)
    }
  }, [threadId, applyFunnelStateRow, removeFunnelStateRow, reloadFunnelStates, reloadCatalogs])

  async function updateStatus(status: 'blocked' | 'archived') {
    setActionError(null)
    setActionPending(status)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setActionError('Сесія недійсна, увійдіть знову')
      setActionPending(null)
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
        setActionError(data.error ?? 'Не вдалося оновити статус ліда')
        return
      }
      setLead((prev) => (prev ? { ...prev, status } : prev))
      onLeadStatusChange?.(leadId, status)
    } catch {
      setActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setActionPending(null)
    }
  }

  function handleBlock() {
    if (!lead) return
    if (!window.confirm(`Заблокувати ${leadLabel(lead)}? Лід більше не отримуватиме повідомлень від сценаріїв.`)) return
    void updateStatus('blocked')
  }

  function handleArchive() {
    if (!lead) return
    if (!window.confirm(`Архівувати ${leadLabel(lead)}? Тред зникне зі стандартного списку чатів.`)) return
    void updateStatus('archived')
  }

  // Manual counterpart to the graph's own subscribe/unsubscribe action node —
  // update-lead-subscription.ts leaves the exact same trail an automatic node
  // would (leads.subscribed + a lead_subscription_events row), so "Підписки
  // за джерелом" counts this the same way it counts an automatic change.
  async function handleToggleSubscription() {
    if (!lead) return
    const nextSubscribed = !lead.subscribed
    const confirmMsg = nextSubscribed
      ? `Підписати ${leadLabel(lead)}? Лід знову зможе отримувати автоматичні повідомлення сценаріїв.`
      : `Відписати ${leadLabel(lead)}? Лід більше не отримуватиме автоматичних повідомлень сценаріїв, усі його активні треди буде закрито.`
    if (!window.confirm(confirmMsg)) return

    setActionError(null)
    setActionPending('subscription')

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setActionError('Сесія недійсна, увійдіть знову')
      setActionPending(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/update-lead-subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId, subscribed: nextSubscribed }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.error ?? 'Не вдалося змінити статус підписки')
        return
      }
      setLead((prev) => (prev ? { ...prev, subscribed: nextSubscribed } : prev))
      // update-lead-subscription.ts closes every open thread this lead has
      // when unsubscribing — reflect that here too, same as handleCloseThread
      // does for a manual close, so the "Закрити тред" button and status
      // badge don't keep showing a thread as open that the server just closed.
      if (!nextSubscribed) {
        setThreadStatus('closed')
        if (threadId) onThreadClosed?.(threadId)
      }
    } catch {
      setActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setActionPending(null)
    }
  }

  async function handleCloseThread() {
    if (!threadId) return
    setActionError(null)
    setActionPending('closed')

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setActionError('Сесія недійсна, увійдіть знову')
      setActionPending(null)
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
        setActionError(data.error ?? 'Не вдалося закрити тред')
        return
      }
      setThreadStatus('closed')
      onThreadClosed?.(threadId)
    } catch {
      setActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setActionPending(null)
    }
  }

  // Symmetric counterpart to handleCloseThread — same endpoint, action: 'open'.
  async function handleOpenThread() {
    if (!threadId) return
    setActionError(null)
    setActionPending('closed')

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setActionError('Сесія недійсна, увійдіть знову')
      setActionPending(null)
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
        setActionError(data.error ?? 'Не вдалося відкрити тред')
        return
      }
      setThreadStatus('open')
      onThreadOpened?.(threadId)
    } catch {
      setActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setActionPending(null)
    }
  }

  // Permanent, irreversible — unlike block/archive this has no way back, so
  // it gets its own explicit-consequence confirm text rather than reusing
  // handleBlock/handleArchive's shorter phrasing.
  async function handleDelete() {
    if (!lead) return
    if (!window.confirm(`Це видалить ліда ${leadLabel(lead)} назавжди — усі повідомлення, задачі та історію. Дію не можна скасувати. Продовжити?`)) {
      return
    }

    setActionError(null)
    setDeleting(true)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setActionError('Сесія недійсна, увійдіть знову')
      setDeleting(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/delete-lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.error ?? 'Не вдалося видалити ліда')
        setDeleting(false)
        return
      }
      onDeleted?.(leadId)
      // Deliberately no setDeleting(false) here on success — onDeleted is
      // expected to unmount this component (close the drawer/modal), so
      // there's no button left to re-enable.
    } catch {
      setActionError('Мережева помилка. Спробуйте ще раз')
      setDeleting(false)
    }
  }

  // All three funnel actions go through one endpoint; the server decides what
  // each one is allowed to touch — move/stop by a specific stateId, attach by
  // threadId+funnelId — so none of them can affect any funnel_states row but
  // the one this call names. The server also kicks funnel-advance right away
  // after a move/attach, so the node runs now rather than on the next cron.
  //
  // busyKey identifies which row's spinner this call owns (a state.id, or
  // 'attach' for the "add funnel" form) so one in-flight action never
  // disables the other rows.
  async function callManageFunnel(body: Record<string, unknown>, busyKey: string): Promise<FunnelStateRef | null | false> {
    setFunnelBusyId(busyKey)
    setFunnelError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setFunnelError('Сесія недійсна, увійдіть знову')
      setFunnelBusyId(null)
      return false
    }

    try {
      const res = await fetch('/.netlify/functions/manage-lead-funnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setFunnelError(data.error ?? 'Не вдалося виконати дію')
        return false
      }
      return (data.state as FunnelStateRef | null) ?? null
    } catch {
      setFunnelError('Мережева помилка. Спробуйте ще раз')
      return false
    } finally {
      setFunnelBusyId(null)
    }
  }

  async function handleMoveNode(row: FunnelStateRef) {
    const nodeId = moveNodeDrafts[row.id]
    if (!nodeId || nodeId === row.funnel_node_id) return
    const updated = await callManageFunnel({ action: 'move', stateId: row.id, nodeId }, row.id)
    if (updated) applyFunnelStateRow(updated)
  }

  async function handleStopFunnel(row: FunnelStateRef, funnelName: string) {
    if (!window.confirm(`Відключити ${leadLabel(lead)} від воронки «${funnelName}»? Інші воронки цього ліда це не торкнеться.`)) return
    const result = await callManageFunnel({ action: 'stop', stateId: row.id }, row.id)
    if (result !== false) applyFunnelStateRow(result ?? { ...row, status: 'stopped' })
  }

  // Stopped rows the AI can actually come back to: only those parked on an AI
  // node. A funnel stopped anywhere else isn't "paused AI" (resume-ai.ts
  // refuses those too), even though the badge lists every stopped row.
  const resumableStates = stoppedFunnelStates.filter((row) => funnelNodes.find((n) => n.id === row.funnel_node_id)?.type === 'ai')

  async function handleResumeAi(reply: boolean) {
    if (!resumeTarget) return
    setResumeBusy(true)
    setResumeNotice(null)
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setResumeNotice('Сесія недійсна, увійдіть знову')
      setResumeBusy(false)
      return
    }
    try {
      const res = await fetch('/.netlify/functions/resume-ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ stateId: resumeTarget.id, reply }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResumeNotice(data.error ?? 'Не вдалося увімкнути AI')
        return
      }
      applyFunnelStateRow({ ...resumeTarget, status: 'ai_active' })
      setResumeNotice(
        !reply
          ? 'AI увімкнено — відповість на наступне повідомлення ліда'
          : data.replying
            ? 'AI увімкнено й уже відповідає на останнє повідомлення'
            : data.reason === 'no_pending_inbound'
              ? 'AI увімкнено. Останнє повідомлення в чаті не від ліда — AI відповість на наступне'
              : 'AI увімкнено, але запустити відповідь не вдалося — відповість на наступне повідомлення',
      )
      setResumeTarget(null)
    } catch {
      setResumeNotice('Мережева помилка. Спробуйте ще раз')
    } finally {
      setResumeBusy(false)
    }
  }

  async function handleAttachFunnel() {
    if (!threadId || !attachFunnelDraft || !attachNodeDraft) return
    const state = await callManageFunnel(
      { action: 'attach', threadId, funnelId: attachFunnelDraft, nodeId: attachNodeDraft },
      'attach',
    )
    if (state) {
      // The server upserts on (thread_id, funnel_id): attaching to a funnel
      // the lead already has a (stopped) row in resets that row in place
      // rather than creating a second one — mirror that here instead of
      // blindly appending, so the list can never show a duplicate.
      applyFunnelStateRow(state)
      setMoveNodeDrafts((prev) => ({ ...prev, [state.id]: state.funnel_node_id ?? '' }))
      setAttachFunnelDraft('')
      setAttachNodeDraft('')
      setShowAttachForm(false)
    }
  }

  async function handleSaveStage() {
    if (!stageDraft) return
    setStageSaving(true)
    setStageSaved(false)
    setStageError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setStageError('Сесія недійсна, увійдіть знову')
      setStageSaving(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-lead-stage', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId, stageId: stageDraft, value: stageValueDraft }),
      })
      const data = await res.json()
      if (!res.ok) {
        setStageError(data.error ?? 'Не вдалося зберегти етап')
        return
      }
      setLead((prev) => (prev ? { ...prev, current_stage_id: stageDraft } : prev))
      setStageSaved(true)
    } catch {
      setStageError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setStageSaving(false)
    }
  }

  async function callLeadTag(tagId: string, action: 'add' | 'remove') {
    setTagError(null)
    setTagPendingId(tagId)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setTagError('Сесія недійсна, увійдіть знову')
      setTagPendingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-lead-tag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId, tagId, action }),
      })
      const data = await res.json()
      if (!res.ok) {
        setTagError(data.error ?? 'Не вдалося оновити теги')
        return
      }
      if (action === 'remove') {
        setTags((prev) => prev.filter((t) => t.id !== tagId))
      } else {
        const added = allTags.find((t) => t.id === tagId)
        if (added) setTags((prev) => (prev.some((t) => t.id === tagId) ? prev : [...prev, added]))
      }
    } catch {
      setTagError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setTagPendingId(null)
    }
  }

  async function handleSaveVariable(variableDefId: string) {
    const value = variableDrafts[variableDefId] ?? ''
    setVariableError(null)
    setVariablePendingId(variableDefId)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setVariableError('Сесія недійсна, увійдіть знову')
      setVariablePendingId(null)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-lead-variable', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId, variableDefId, value }),
      })
      const data = await res.json()
      if (!res.ok) {
        setVariableError(data.error ?? 'Не вдалося зберегти змінну')
        return
      }

      const saved = value.trim() === '' ? null : value
      setVariables((prev) => {
        if (prev.some((v) => v.id === variableDefId)) {
          return prev.map((v) => (v.id === variableDefId ? { ...v, value: saved } : v))
        }
        const def = allVariableDefs.find((d) => d.id === variableDefId)
        return def ? [...prev, { id: def.id, label: def.label, value: saved }] : prev
      })
      // Drops the edit buffer so the row goes back to rendering the saved
      // value — leaving it would keep showing the draft as if unsaved.
      setVariableDrafts((prev) => {
        const next = { ...prev }
        delete next[variableDefId]
        return next
      })
    } catch {
      setVariableError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setVariablePendingId(null)
    }
  }

  async function saveLeadNotes() {
    if (!lead) return
    setNotesSaving(true)
    setNotesSaved(false)
    setActionError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setActionError('Сесія недійсна, увійдіть знову')
      setNotesSaving(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-lead-notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ leadId, notes: notesDraft }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.error ?? 'Не вдалося зберегти нотатки')
        return
      }
      const saved = notesDraft.trim() === '' ? null : notesDraft
      setLead((prev) => (prev ? { ...prev, manager_notes: saved } : prev))
      setNotesSaved(true)
    } catch {
      setActionError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setNotesSaving(false)
    }
  }

  async function callSaveLeadTask(payload: Record<string, unknown>): Promise<{ ok: boolean; task?: LeadTask } | null> {
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setTaskError('Сесія недійсна, увійдіть знову')
      return null
    }

    try {
      const res = await fetch('/.netlify/functions/save-lead-task', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setTaskError(data.error ?? 'Не вдалося зберегти задачу')
        return null
      }
      return data
    } catch {
      setTaskError('Мережева помилка. Спробуйте ще раз')
      return null
    }
  }

  async function handleAddTask(event: FormEvent) {
    event.preventDefault()
    if (!newTaskTitle.trim() || addingTask) return

    setTaskError(null)
    setAddingTask(true)

    const payload: Record<string, unknown> = { action: 'create', leadId, title: newTaskTitle.trim() }
    if (newTaskDeadline) payload.deadline = new Date(newTaskDeadline).toISOString()

    const data = await callSaveLeadTask(payload)
    if (data?.task) {
      setTasks((prev) => [...prev, data.task as LeadTask])
      setNewTaskTitle('')
      setNewTaskDeadline('')
    }
    setAddingTask(false)
  }

  async function handleToggleTask(task: LeadTask) {
    setTaskError(null)
    setTaskPendingId(task.id)
    const data = await callSaveLeadTask({ action: 'update', taskId: task.id, completed: !task.completed })
    if (data?.task) {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? (data.task as LeadTask) : t)))
    }
    setTaskPendingId(null)
  }

  async function handleDeleteTask(taskId: string) {
    setTaskError(null)
    setTaskPendingId(taskId)
    const data = await callSaveLeadTask({ action: 'delete', taskId })
    if (data?.ok) {
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
    }
    setTaskPendingId(null)
  }

  if (loading && !lead) {
    return (
      <div className="profile-panel profile-panel-loading">
        <IconSpinner size={20} />
      </div>
    )
  }

  if (loadError || !lead) {
    return (
      <div className="profile-panel profile-panel-loading">
        <div className="alert alert-error">Не вдалося завантажити профіль ліда</div>
      </div>
    )
  }

  // Only what isn't already on the lead is worth offering in the "add" pickers.
  const attachNodes = funnelNodes.filter((n) => n.funnel_id === attachFunnelDraft)

  const availableTags = allTags.filter((t) => !tags.some((attached) => attached.id === t.id))
  const unsetVariableDefs = allVariableDefs.filter((d) => !variables.some((v) => v.id === d.id))

  return (
    <div className="profile-panel">
      <div className="profile-drawer-header">
        <span className="thread-avatar">{leadLabel(lead).slice(0, 1).replace('@', '')}</span>
        <div className="profile-drawer-header-text">
          <div className="thread-item-name">{leadLabel(lead)}</div>
          {/* leadLabel already prefers @username, so this only adds
              information when there wasn't one to begin with. */}
          {!lead.username && (
            <div className="settings-row-hint" style={{ marginTop: 0 }}>
              Без нікнейму
            </div>
          )}
        </div>
        {onClose && (
          <button type="button" className="btn-icon-ghost" onClick={onClose} aria-label="Закрити профіль">
            <IconClose size={15} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          className={`badge ${lead.status === 'blocked' ? 'badge-danger' : lead.status === 'archived' ? 'badge-neutral' : 'badge-success'}`}
        >
          {lead.status === 'blocked' ? 'Заблокований' : lead.status === 'archived' ? 'Архів' : 'Активний'}
        </span>
        {stoppedFunnelStates.length > 0 && (
          <span
            className="badge badge-warning"
            title={stoppedFunnelStates
              .map((row) => {
                const funnelName = funnels.find((f) => f.id === row.funnel_id)?.name ?? 'Воронку видалено'
                const node = funnelNodes.find((n) => n.id === row.funnel_node_id)
                const nodeName = node ? nodeLabel(node) : 'Вузол не визначено'
                return `${funnelName} → ${nodeName}`
              })
              .join('\n')}
          >
            AI зупинено
          </span>
        )}
        {resumableStates.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem', minHeight: 0 }}
            onClick={() => {
              setResumeNotice(null)
              setResumeTarget(resumableStates[resumableStates.length - 1])
            }}
          >
            Увімкнути AI
          </button>
        )}
        {resumeNotice && <span className="flow-node-hint" style={{ margin: 0 }}>{resumeNotice}</span>}
      </div>

      {resumeTarget &&
        createPortal(
          <div className="modal-backdrop" onClick={() => !resumeBusy && setResumeTarget(null)}>
            <div className="modal-card modal-card-wide" role="dialog" aria-modal="true" aria-labelledby="resume-ai-title" onClick={(e) => e.stopPropagation()}>
              <h2 className="modal-title" id="resume-ai-title">
                Увімкнути AI
              </h2>
              {resumableStates.length > 1 && (
                <select
                  className="input"
                  value={resumeTarget.id}
                  onChange={(e) => setResumeTarget(resumableStates.find((r) => r.id === e.target.value) ?? resumeTarget)}
                  aria-label="Воронка"
                >
                  {resumableStates.map((row) => {
                    const node = funnelNodes.find((n) => n.id === row.funnel_node_id)
                    return (
                      <option key={row.id} value={row.id}>
                        {(funnels.find((f) => f.id === row.funnel_id)?.name ?? 'Воронку видалено') + (node ? ` → ${nodeLabel(node)}` : '')}
                      </option>
                    )
                  })}
                </select>
              )}
              <p style={{ margin: 0 }}>АІ має відповісти на останнє повідомлення ліда?</p>
              <p className="flow-node-hint" style={{ margin: 0 }}>
                AI побачить усе листування за час паузи, включно з вашими повідомленнями. «Так» — відповість зараз,
                якщо останнім писав лід. «Ні» — підхопить лише наступне нове повідомлення ліда.
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" disabled={resumeBusy} onClick={() => setResumeTarget(null)}>
                  Скасувати
                </button>
                <button type="button" className="btn btn-secondary" disabled={resumeBusy} onClick={() => handleResumeAi(false)}>
                  Ні
                </button>
                <button type="button" className="btn btn-primary" disabled={resumeBusy} onClick={() => handleResumeAi(true)}>
                  {resumeBusy ? <IconSpinner size={14} /> : null}
                  Так
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <div className="profile-actions">
        {lead.status !== 'blocked' && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            disabled={actionPending !== null}
            onClick={handleBlock}
            title="Заблокувати"
            aria-label="Заблокувати"
          >
            {actionPending === 'blocked' ? <IconSpinner size={15} /> : <IconBan size={15} />}
          </button>
        )}
        {lead.status !== 'archived' && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            disabled={actionPending !== null}
            onClick={handleArchive}
            title="Архівувати"
            aria-label="Архівувати"
          >
            {actionPending === 'archived' ? <IconSpinner size={15} /> : <IconArchiveBox size={15} />}
          </button>
        )}
        {threadId && threadStatus === 'open' && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            disabled={actionPending !== null}
            onClick={() => void handleCloseThread()}
            title="Закрити тред"
            aria-label="Закрити тред"
          >
            {actionPending === 'closed' ? <IconSpinner size={15} /> : <IconClose size={15} />}
          </button>
        )}
        {threadId && threadStatus === 'closed' && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            disabled={actionPending !== null}
            onClick={() => void handleOpenThread()}
            title="Відкрити чат"
            aria-label="Відкрити чат"
          >
            {actionPending === 'closed' ? <IconSpinner size={15} /> : <IconInbox size={15} />}
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          disabled={actionPending !== null}
          onClick={() => void handleToggleSubscription()}
          style={lead.subscribed ? undefined : { opacity: 0.5 }}
          title={lead.subscribed ? 'Відписати' : 'Підписати'}
          aria-label={lead.subscribed ? 'Відписати' : 'Підписати'}
          aria-pressed={lead.subscribed}
        >
          {actionPending === 'subscription' ? (
            <IconSpinner size={15} />
          ) : lead.subscribed ? (
            <IconBell size={15} />
          ) : (
            <IconBellOff size={15} />
          )}
        </button>
      </div>

      {actionError && <div className="alert alert-error">{actionError}</div>}

      <section className="profile-section">
        <h4>Системна інформація</h4>
        <div className="profile-kv">
          <div className="profile-kv-row">
            <span>Telegram ID</span>
            <span>{lead.external_id}</span>
          </div>
          <div className="profile-kv-row">
            <span>Дата реєстрації</span>
            <span>
              {new Date(lead.created_at).toLocaleDateString('uk-UA', { day: '2-digit', month: 'long', year: 'numeric' })}
            </span>
          </div>
          <div className="profile-kv-row">
            <span>Джерело</span>
            <span>
              {!lead.source_link_id ? (
                'Прямий перехід'
              ) : loading ? (
                '…'
              ) : source ? (
                <>
                  {source.linkName}
                  {(source.params.campaign || source.params.placement) && (
                    <span className="profile-source-params">
                      {[source.params.campaign, source.params.placement].filter(Boolean).map(String).join(' · ')}
                    </span>
                  )}
                </>
              ) : (
                'Прямий перехід'
              )}
            </span>
          </div>
        </div>
      </section>

      <section className="profile-section">
        <h4>Воронка</h4>
        {loading ? (
          <p className="settings-row-hint">Завантаження…</p>
        ) : !threadId ? (
          <p className="settings-row-hint">Немає треда — воронка прив'язується до розмови.</p>
        ) : (
          <>
            {funnelStates.length === 0 ? (
              <p className="settings-row-hint">{completedFunnelStates.length > 0 ? 'Зараз не в активній воронці.' : 'Не в жодній воронці.'}</p>
            ) : (
              <div className="profile-funnel-list">
                {funnelStates.map((row) => {
                  const funnelName = funnels.find((f) => f.id === row.funnel_id)?.name ?? 'Воронку видалено'
                  const nodes = funnelNodes.filter((n) => n.funnel_id === row.funnel_id)
                  const node = nodes.find((n) => n.id === row.funnel_node_id)
                  const nodeName = node ? nodeLabel(node) : 'Вузол не визначено'
                  const draft = moveNodeDrafts[row.id] ?? ''
                  const busy = funnelBusyId === row.id

                  return (
                    <div className="profile-funnel-item" key={row.id}>
                      <div className="profile-funnel-current">
                        <span className="profile-funnel-name">{funnelName}</span>
                        <span className="profile-funnel-node">{nodeName}</span>
                        {row.status === 'ai_active' && <span className="badge badge-neutral">AI</span>}
                      </div>

                      <div className="profile-stage-row">
                        <select
                          className="input"
                          value={draft}
                          onChange={(e) => setMoveNodeDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                          aria-label={`Перемкнути вузол — ${funnelName}`}
                        >
                          <option value="">— Оберіть вузол —</option>
                          {nodes.map((n) => (
                            <option key={n.id} value={n.id}>
                              {nodeLabel(n)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || !draft || draft === row.funnel_node_id}
                          onClick={() => void handleMoveNode(row)}
                        >
                          {busy ? <IconSpinner size={15} /> : 'Перемкнути'}
                        </button>
                      </div>

                      <button
                        type="button"
                        className="btn btn-danger-ghost"
                        disabled={busy}
                        onClick={() => void handleStopFunnel(row, funnelName)}
                        style={{ alignSelf: 'flex-start' }}
                      >
                        Відключити від цього тунелю
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {funnelStates.length > 0 && (
              <p className="settings-row-hint">Після перемикання крок вузла виконується одразу.</p>
            )}

            {completedFunnelStates.length > 0 && (
              <div className="profile-funnel-done">
                {completedFunnelStates.map((row) => {
                  const funnelName = funnels.find((f) => f.id === row.funnel_id)?.name ?? 'Воронку видалено'
                  const node = funnelNodes.find((n) => n.id === row.funnel_node_id)
                  return (
                    <div className="profile-funnel-done-item" key={row.id}>
                      <IconCheckCircle size={13} />
                      <span>
                        Воронку завершено: {funnelName}
                        {node ? ` → ${nodeLabel(node)}` : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {showAttachForm ? (
              <>
                <label className="profile-field-label" htmlFor="funnelAttach">
                  Нова воронка
                </label>
                <select
                  id="funnelAttach"
                  className="input"
                  value={attachFunnelDraft}
                  onChange={(e) => {
                    setAttachFunnelDraft(e.target.value)
                    setAttachNodeDraft('')
                  }}
                >
                  <option value="">— Оберіть воронку —</option>
                  {funnels.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>

                {attachFunnelDraft && completedFunnelStates.some((r) => r.funnel_id === attachFunnelDraft) && (
                  <p className="settings-row-hint" style={{ margin: 0 }}>
                    Лід уже пройшов цю воронку до кінця — підключення запустить її заново з обраного вузла.
                  </p>
                )}
                {attachFunnelDraft && (
                  <div className="profile-stage-row">
                    <select className="input" value={attachNodeDraft} onChange={(e) => setAttachNodeDraft(e.target.value)}>
                      <option value="">— Стартовий вузол —</option>
                      {attachNodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {nodeLabel(n)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={funnelBusyId === 'attach' || !attachNodeDraft}
                      onClick={() => void handleAttachFunnel()}
                    >
                      {funnelBusyId === 'attach' ? <IconSpinner size={15} /> : 'Підключити'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setShowAttachForm(false)}>
                      Скасувати
                    </button>
                  </div>
                )}
              </>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowAttachForm(true)}
                style={{ alignSelf: 'flex-start' }}
              >
                + Підключити до нової воронки
              </button>
            )}
          </>
        )}
        {funnelError && <div className="alert alert-error">{funnelError}</div>}
      </section>

      <section className="profile-section">
        <h4>Етап продажу</h4>
        {loading ? (
          <p className="settings-row-hint">Завантаження…</p>
        ) : (
          <>
            <select
              className="input"
              value={stageDraft}
              onChange={(e) => {
                setStageDraft(e.target.value)
                setStageSaved(false)
              }}
              aria-label="Етап продажу"
            >
              {/* No "— Не задано —" option: «Підписка» (position 0, first in
                  the ordered list) is the base state every lead is created
                  with, so a stage can only be moved forward, never cleared.
                  The disabled placeholder only ever shows for legacy rows the
                  backfill somehow missed. */}
              {!stageDraft && (
                <option value="" disabled>
                  — Не задано —
                </option>
              )}
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <div className="profile-stage-row">
              <input
                className="input"
                type="number"
                step="0.01"
                value={stageValueDraft}
                onChange={(e) => {
                  setStageValueDraft(e.target.value)
                  setStageSaved(false)
                }}
                placeholder="Сума"
                aria-label="Сума"
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!stageDraft || stageSaving}
                onClick={() => void handleSaveStage()}
              >
                {stageSaving ? <IconSpinner size={15} /> : stageSaved ? 'Збережено ✓' : 'Зберегти'}
              </button>
            </div>

            {/* Every save appends to lead_stage_history, so moving a lead back
                and forth keeps the whole trail rather than overwriting it. */}
            <p className="settings-row-hint">Кожне збереження додає запис в історію етапів.</p>
            {stageError && <div className="alert alert-error">{stageError}</div>}
          </>
        )}
      </section>

      <section className="profile-section">
        <h4>Теги</h4>
        {loading ? (
          <p className="settings-row-hint">Завантаження…</p>
        ) : (
          <>
            {tags.length === 0 ? (
              <p className="settings-row-hint">Немає тегів</p>
            ) : (
              <div className="profile-tags">
                {tags.map((tag) => (
                  <span key={tag.id} className="badge badge-tag profile-tag-editable">
                    {tag.name}
                    <button
                      type="button"
                      className="profile-tag-remove"
                      onClick={() => void callLeadTag(tag.id, 'remove')}
                      disabled={tagPendingId === tag.id}
                      aria-label={`Зняти тег ${tag.name}`}
                    >
                      {tagPendingId === tag.id ? <IconSpinner size={10} /> : <IconClose size={10} />}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {availableTags.length > 0 && (
              <select
                className="input profile-inline-select"
                value=""
                disabled={tagPendingId !== null}
                onChange={(e) => {
                  if (e.target.value) void callLeadTag(e.target.value, 'add')
                }}
                aria-label="Додати тег"
              >
                <option value="">+ Додати тег</option>
                {availableTags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            {tagError && <div className="alert alert-error">{tagError}</div>}
          </>
        )}
      </section>

      <section className="profile-section">
        <h4>Фінанси</h4>
        {loading ? (
          <p className="settings-row-hint">Завантаження…</p>
        ) : (
          <>
            {variables.length === 0 ? (
              <p className="settings-row-hint">Немає збережених змінних</p>
            ) : (
              <div className="profile-var-list">
                {variables.map((v) => {
                  const draft = variableDrafts[v.id]
                  const dirty = draft !== undefined && draft !== (v.value ?? '')
                  return (
                    <div className="profile-var-row" key={v.id}>
                      <label className="profile-var-label" htmlFor={`lead-var-${v.id}`}>
                        {v.label}
                      </label>
                      <div className="profile-var-controls">
                        <input
                          id={`lead-var-${v.id}`}
                          className="input"
                          value={draft ?? v.value ?? ''}
                          placeholder="—"
                          onChange={(e) => setVariableDrafts((prev) => ({ ...prev, [v.id]: e.target.value }))}
                        />
                        {dirty && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-icon"
                            disabled={variablePendingId === v.id}
                            onClick={() => void handleSaveVariable(v.id)}
                            aria-label={`Зберегти значення «${v.label}»`}
                          >
                            {variablePendingId === v.id ? <IconSpinner size={14} /> : <IconCheckCircle size={14} />}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {unsetVariableDefs.length > 0 && (
              <select
                className="input profile-inline-select"
                value=""
                onChange={(e) => {
                  const def = allVariableDefs.find((d) => d.id === e.target.value)
                  if (!def) return
                  // Adds the row locally so it can be typed into — nothing is
                  // written until its save button is pressed.
                  setVariables((prev) => (prev.some((v) => v.id === def.id) ? prev : [...prev, { id: def.id, label: def.label, value: null }]))
                  setVariableDrafts((prev) => ({ ...prev, [def.id]: '' }))
                }}
                aria-label="Додати змінну"
              >
                <option value="">+ Додати змінну</option>
                {unsetVariableDefs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}
            {variableError && <div className="alert alert-error">{variableError}</div>}
          </>
        )}
      </section>

      <section className="profile-section">
        <h4>Нотатки менеджера</h4>
        <textarea
          className="profile-notes-textarea"
          value={notesDraft}
          onChange={(e) => {
            setNotesDraft(e.target.value)
            setNotesSaved(false)
          }}
          placeholder="Внутрішні нотатки — лід їх не бачить…"
        />
        <button type="button" className="btn btn-primary" disabled={notesSaving} onClick={() => void saveLeadNotes()}>
          {notesSaving ? <IconSpinner size={15} /> : notesSaved ? 'Збережено ✓' : 'Зберегти нотатки'}
        </button>
      </section>

      <section className="profile-section">
        <h4>Задачі</h4>

        {loading ? (
          <p className="settings-row-hint">Завантаження…</p>
        ) : tasks.length === 0 ? (
          <p className="settings-row-hint">Немає задач</p>
        ) : (
          <div className="task-list">
            {tasks.map((task) => {
              const overdue = !task.completed && task.deadline !== null && new Date(task.deadline).getTime() < Date.now()
              return (
                <div className="task-row" key={task.id}>
                  <label className="task-checkbox">
                    <input
                      type="checkbox"
                      checked={task.completed}
                      disabled={taskPendingId === task.id}
                      onChange={() => void handleToggleTask(task)}
                    />
                    <span className={`task-title${task.completed ? ' task-title-done' : ''}`}>{task.title}</span>
                  </label>
                  {task.deadline && (
                    <span className={`task-deadline${overdue ? ' task-deadline-overdue' : ''}`}>
                      {new Date(task.deadline).toLocaleString('uk-UA', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn-icon-ghost"
                    disabled={taskPendingId === task.id}
                    onClick={() => void handleDeleteTask(task.id)}
                    aria-label="Видалити задачу"
                  >
                    {taskPendingId === task.id ? <IconSpinner size={13} /> : <IconTrash size={13} />}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {taskError && <div className="alert alert-error">{taskError}</div>}

        <form className="task-add-form" onSubmit={handleAddTask}>
          <input
            className="input"
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="Нова задача…"
            aria-label="Назва задачі"
          />
          <div className="task-add-form-row">
            <input
              className="input"
              type="datetime-local"
              value={newTaskDeadline}
              onChange={(e) => setNewTaskDeadline(e.target.value)}
              aria-label="Дедлайн (опційно)"
            />
            <button type="submit" className="btn btn-secondary" disabled={!newTaskTitle.trim() || addingTask}>
              {addingTask ? <IconSpinner size={15} /> : 'Додати'}
            </button>
          </div>
        </form>
      </section>

      <section className="profile-section">
        <h4>Небезпечна зона</h4>
        <p className="settings-row-hint">
          Видаляє ліда назавжди — усі повідомлення, треди, задачі та історію. Це не архівування, дію не можна
          скасувати.
        </p>
        <button type="button" className="btn btn-danger-ghost" disabled={deleting} onClick={() => void handleDelete()}>
          {deleting ? <IconSpinner size={15} /> : <IconTrash size={15} />}
          Видалити ліда назавжди
        </button>
      </section>
    </div>
  )
}
