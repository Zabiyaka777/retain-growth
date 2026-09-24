import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import ReactFlow, {
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type XYPosition,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { supabase } from '../lib/supabaseClient'
import {
  IconAlert,
  IconArrowLeft,
  IconBolt,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClose,
  IconCpu,
  IconEdit,
  IconFile,
  IconGrip,
  IconImage,
  IconListChecks,
  IconLogIn,
  IconMic,
  IconMusic,
  IconPlug,
  IconPlus,
  IconPoll,
  IconSettings,
  IconShield,
  IconSparkles,
  IconSpinner,
  IconStopwatch,
  IconTarget,
  IconBranch,
  IconSync,
  IconDuplicate,
  IconTrash,
  IconVideo,
  IconVideoNote,
} from '../components/icons'

type NodeKind = 'entry' | 'message' | 'action' | 'ai' | 'delay' | 'condition' | 'conversion'

interface AiTask {
  id: string
  description: string
}

// Handle ids double as funnel_edges.from_button_id — kept in sync with the
// EXIT_* constants in ai-respond.ts.
type ConditionCombinator = 'and' | 'or'
type ConditionKind = 'tag' | 'variable'

interface ConditionRule {
  id: string
  kind: ConditionKind
  tag_op?: 'has' | 'not_has'
  tag_id?: string
  var_op?: 'eq' | 'neq' | 'contains'
  variable_def_id?: string
  value?: string
}

// Handle ids, stored in funnel_edges.from_button_id. Must stay in sync with
// CONDITION_TRUE/CONDITION_FALSE in _shared/funnel-graph.ts.
const CONDITION_EXITS: { id: string; label: string; tone: 'true' | 'false' }[] = [
  { id: 'condition_true', label: 'Так', tone: 'true' },
  { id: 'condition_false', label: 'Ні', tone: 'false' },
]

const TAG_OPERATORS: { value: 'has' | 'not_has'; label: string }[] = [
  { value: 'has', label: 'Виконано' },
  { value: 'not_has', label: 'Не виконано' },
]

const VARIABLE_OPERATORS: { value: 'eq' | 'neq' | 'contains'; label: string }[] = [
  { value: 'eq', label: 'Дорівнює' },
  { value: 'neq', label: 'Не дорівнює' },
  { value: 'contains', label: 'Містить' },
]

const AI_EXITS: { id: string; label: string; tone: 'done' | 'error' | 'manager' }[] = [
  { id: 'tasks_completed', label: 'Завдання виконані', tone: 'done' },
  { id: 'ai_error', label: 'Помилка AI Агента', tone: 'error' },
  { id: 'manager_needed', label: 'Потрібен менеджер', tone: 'manager' },
]

// Kept in sync with ai-respond.ts's own DEFAULT_MODEL, which applies the same
// fallback server-side when a node's model field is left blank.
const AI_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5'

// Mirrors DEFAULT_MIN_ATTEMPTS_BEFORE_ERROR in ai-respond.ts.
const AI_DEFAULT_MIN_ATTEMPTS = 2

// openrouter.ai/api/v1/models is public (no key) — fetched once per page load
// and shared by every ai node via this promise cache.
let openRouterModelsPromise: Promise<string[]> | null = null

function loadOpenRouterModels(): Promise<string[]> {
  if (!openRouterModelsPromise) {
    openRouterModelsPromise = fetch('https://openrouter.ai/api/v1/models')
      .then((r) => r.json())
      .then((d) => ((d?.data ?? []) as { id?: string }[]).map((m) => m.id).filter((id): id is string => !!id).sort())
      .catch(() => [])
  }
  return openRouterModelsPromise
}

function useOpenRouterModels(enabled: boolean): string[] {
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadOpenRouterModels().then((m) => {
      if (!cancelled) setModels(m)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return models
}
type ActionType = 'set_tag' | 'set_variable' | 'subscribe' | 'unsubscribe' | 'open_chat' | 'close_chat'

// actionType 'edge' (default, omitted for older saved buttons too) connects
// to the next node via a source Handle, resolved by resolveNextNode on the
// backend. 'link' renders as a direct URL button in the channel's inline
// keyboard instead — Telegram/WhatsApp/FBM never send a callback for those,
// so there's nowhere for an edge to lead; no Handle is shown for them.
interface FunnelButton {
  id: string
  label: string
  actionType?: 'edge' | 'link'
  url?: string
}

type AttachmentType = 'photo' | 'video' | 'video_note' | 'audio' | 'animation' | 'document' | 'voice' | 'poll'

// The pre-block-editor shape ({ text, attachments }) — kept only so
// normalizeChannelConfig can still read data saved before this change.
interface MessageAttachment {
  type: AttachmentType
  url: string
  filename?: string
}

interface TextBlock {
  id: string
  kind: 'text'
  text: string
}

interface AttachmentBlock {
  id: string
  kind: 'attachment'
  type: AttachmentType
  url: string
  filename?: string
}

type ContentBlock = TextBlock | AttachmentBlock

type ChannelKey = 'telegram' | 'whatsapp' | 'fbm'
type FormattingScheme = 'markdown_v2' | 'whatsapp' | 'none'

const TEXT_BLOCK_ID = 'text'

// A channel's content is an ordered, drag-reorderable list of blocks: always
// exactly one text block plus zero or more attachment blocks (multiple
// attachments allowed, e.g. two photos + text). The text block's own text
// carries the channel's lightweight markup directly (the formatting toolbar
// wraps a selection in delimiter characters — Telegram's own MarkdownV2
// marks for telegram, WhatsApp's own marks for whatsapp; fbm has none).
// `formatting` just names the scheme. _shared/funnel-graph.ts's
// sendGraphMessage turns the telegram block's text into escaped, valid
// MarkdownV2 and sends attachment blocks in list order.
interface ChannelConfig {
  formatting: FormattingScheme
  blocks: ContentBlock[]
}

const MESSAGE_CHAR_LIMIT = 4096
const MESSAGE_CHAR_LIMITS: Record<ChannelKey, number> = { telegram: 4096, whatsapp: 4096, fbm: 2000 }
const CHANNEL_LABELS: Record<ChannelKey, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', fbm: 'FB Messenger' }

function defaultFormattingFor(channel: ChannelKey): FormattingScheme {
  return channel === 'telegram' ? 'markdown_v2' : channel === 'whatsapp' ? 'whatsapp' : 'none'
}

function emptyChannelConfig(formatting: FormattingScheme): ChannelConfig {
  return { formatting, blocks: [{ id: TEXT_BLOCK_ID, kind: 'text', text: '' }] }
}

function textBlockOf(config: ChannelConfig): TextBlock {
  return config.blocks.find((b): b is TextBlock => b.kind === 'text') ?? { id: TEXT_BLOCK_ID, kind: 'text', text: '' }
}

// Reads a channel config that may still be in the pre-block shape
// ({ text, attachments }) — real saved data (e.g. an already-live funnel)
// must keep loading and sending correctly without a data migration —
// and upgrades it in memory to { blocks }. Re-saving through the editor
// writes the new shape going forward.
function normalizeChannelConfig(raw: unknown, fallbackFormatting: FormattingScheme): ChannelConfig {
  const obj = (raw ?? {}) as {
    formatting?: FormattingScheme
    blocks?: ContentBlock[]
    text?: string
    attachments?: MessageAttachment[]
  }
  const formatting = obj.formatting ?? fallbackFormatting

  if (Array.isArray(obj.blocks)) {
    return { formatting, blocks: obj.blocks.length > 0 ? obj.blocks : [{ id: TEXT_BLOCK_ID, kind: 'text', text: '' }] }
  }

  const blocks: ContentBlock[] = [{ id: TEXT_BLOCK_ID, kind: 'text', text: obj.text ?? '' }]
  for (const a of obj.attachments ?? []) {
    blocks.push({ id: crypto.randomUUID().slice(0, 8), kind: 'attachment', type: a.type, url: a.url, filename: a.filename })
  }
  return { formatting, blocks }
}

// Mirrors funnel_nodes.config exactly as funnel-processor-v2.ts /
// _shared/funnel-graph.ts already read it — kept identical, not reinvented.
// track_as_conversion applies only to the entry node. Entry-point matching
// itself now lives outside this config, in lead_gen_links (see
// /dashboard/leadgentools) rather than in a pattern stored here.
interface NodeConfig {
  // Human-readable node name, editable on the node itself. Applies to every
  // node type; blank just falls back to the type name as placeholder.
  label?: string
  channels?: { telegram: ChannelConfig | null; whatsapp: ChannelConfig | null; fbm: ChannelConfig | null }
  buttons?: FunnelButton[]
  // Telegram leaves an inline keyboard tappable forever. Off by default so
  // existing funnels keep behaving exactly as they do today.
  clear_buttons_after_use?: boolean
  action_type?: ActionType
  payload?: { tag_id?: string; variable_def_id?: string; value?: string }
  track_as_conversion?: boolean
  // 'entry' nodes only. true (default, matches pre-existing behavior) means a
  // repeated /start via a link into this funnel always resets the lead's
  // funnel_states row to this entry node, even mid-AI-conversation. false
  // protects an active AI conversation: a repeated /start is ignored outright
  // while the lead's state for this funnel is ai_active, instead of yanking
  // them out of a live exchange with the model.
  restart_on_reentry?: boolean
  // 'ai' nodes only — the model answers every following message on the thread
  // until an "Відкрити чат" action hands it back to a human. context + rules
  // are joined into the system prompt server-side (see ai-respond.ts).
  context?: string
  rules?: string
  model?: string
  // Ordered: the model is told to work through them top to bottom, and marks
  // each done via a tool call. Empty means the node never self-advances.
  tasks?: AiTask[]
  // Clarification rounds before report_error actually leaves the node.
  min_attempts_before_error?: number
  // Default off — existing nodes keep today's global lead_memory behavior
  // unchanged. On: remember_fact scopes to this exact node (node_lead_memory)
  // instead, isolated from every other AI node's memory of the same lead.
  memory_enabled?: boolean
  // 'delay' nodes only. relative = now + hours/minutes; exact = next time the
  // wall clock hits delay_time in delay_tz.
  delay_mode?: 'relative' | 'exact'
  delay_hours?: number
  delay_minutes?: number
  delay_time?: string
  delay_tz?: string
  // 'condition' nodes only. Rules are evaluated against the lead's tags and
  // variables and joined by `combinator`; the result picks the Так/Ні exit.
  combinator?: ConditionCombinator
  conditions?: ConditionRule[]
  // 'conversion' nodes only — which analytics-funnel stage entering this node
  // marks the lead as having reached.
  stage_id?: string
}

// Offset so the copy lands beside the original rather than exactly on top of
// it, where it would look like nothing happened.
const DUPLICATE_OFFSET = 40

/**
 * "Повідомлення 2" -> "Повідомлення 2 (копія)", and "… (копія)" ->
 * "… (копія 2)" if that name is taken. Same intent as the palette's numbering:
 * two nodes should never carry the same name.
 */
function nextCopyLabel(label: string | undefined, nodes: Node<NodeData>[]): string {
  // Strip an existing "(копія)"/"(копія N)" first, so duplicating a copy gives
  // "Оффер (копія 2)" rather than "Оффер (копія) (копія)".
  const base = ((label ?? '').trim() || 'Вузол').replace(/\s*\(копія(?:\s+\d+)?\)$/, '').trim() || 'Вузол'
  const taken = new Set(nodes.map((n) => (n.data.config.label ?? '').trim()))

  const first = `${base} (копія)`
  if (!taken.has(first)) return first

  for (let n = 2; n < 100; n++) {
    const candidate = `${base} (копія ${n})`
    if (!taken.has(candidate)) return candidate
  }
  return first
}

interface NodeData {
  config: NodeConfig
  onChange: (patch: Partial<NodeConfig>) => void
  onDelete: () => void
  onDuplicate: () => void
}

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

interface TagOption {
  id: string
  name: string
}

interface VariableDefOption {
  id: string
  key: string
  label: string
}

// Built-in stages ("Підписка"/"Продажа") arrive with is_locked true and no
// org_id — they're shared rows, not per-org copies, so they can't be renamed
// or deleted from here.
interface StageOption {
  id: string
  name: string
  is_locked: boolean
  position: number
  /** Fires a Meta conversion whenever a lead enters this stage. */
  track_as_conversion: boolean
  meta_event_name: string | null
}

/** Conversion settings a stage can be created with, or updated to. */
interface StageConversionConfig {
  trackAsConversion: boolean
  metaEventName: string
}

type CreateResult<T> = { ok: true; item: T } | { ok: false; error: string }

// Lets ActionNodeView (rendered by ReactFlow via the static nodeTypes map,
// so it can't receive fresh props each render) reach the org's tags/variable
// catalog and the create-new-element miniforms without prop-drilling through
// NodeData or recreating nodeTypes (which would remount every node).
interface ElementsContextValue {
  tags: TagOption[]
  variableDefs: VariableDefOption[]
  stages: StageOption[]
  createTag: (name: string) => Promise<CreateResult<TagOption>>
  createVariableDef: (key: string, label: string) => Promise<CreateResult<VariableDefOption>>
  createStage: (name: string, conversion: StageConversionConfig) => Promise<CreateResult<StageOption>>
  updateStageConversion: (id: string, conversion: StageConversionConfig) => Promise<CreateResult<StageOption>>
}

const ElementsContext = createContext<ElementsContextValue | null>(null)

function actionUiKind(actionType?: ActionType): '' | 'tag' | 'variable' | 'subscribe' | 'unsubscribe' | 'chat' {
  if (actionType === 'set_tag') return 'tag'
  if (actionType === 'set_variable') return 'variable'
  if (actionType === 'subscribe') return 'subscribe'
  if (actionType === 'unsubscribe') return 'unsubscribe'
  if (actionType === 'open_chat' || actionType === 'close_chat') return 'chat'
  return ''
}

interface GraphValidationResult {
  error: string | null
  // Set when the graph is savable but something about it is worth flagging —
  // currently just "no entry point at all". Never blocks the save.
  warning: string | null
}

function validateGraph(nodes: Node<NodeData>[], edges: Edge[]): GraphValidationResult {
  const entryCount = nodes.filter((n) => n.type === 'entry').length
  // Any number of entry points is valid now — each lead-gen link picks its
  // own. Zero is still allowed (e.g. a work-in-progress graph), just
  // flagged: nothing can enroll a lead into it yet.
  const warning =
    entryCount === 0
      ? 'Граф не має точки входу — посилання лідогенерації не зможуть запустити цей тунель, поки ви не додасте хоча б один вузол «Точка входу».'
      : null

  const nodeIds = new Set(nodes.map((n) => n.id))

  for (const node of nodes) {
    const config = node.data.config
    if (node.type === 'message') {
      const telegram = normalizeChannelConfig(config.channels?.telegram, 'markdown_v2')
      const text = textBlockOf(telegram).text
      if (!text.trim()) return { error: 'Кожне повідомлення повинно мати текст', warning: null }
      if (text.length > MESSAGE_CHAR_LIMIT) return { error: `Текст повідомлення перевищує ${MESSAGE_CHAR_LIMIT} символів`, warning: null }

      // Telegram is the only channel that's required to have text (it's the
      // only one that currently sends) — WhatsApp/FBM may be left blank, but
      // if filled in, still can't exceed that channel's own limit.
      for (const channelKey of ['whatsapp', 'fbm'] as ChannelKey[]) {
        const channelConfig = normalizeChannelConfig(config.channels?.[channelKey], defaultFormattingFor(channelKey))
        const channelText = textBlockOf(channelConfig).text
        const limit = MESSAGE_CHAR_LIMITS[channelKey]
        if (channelText.length > limit) {
          return { error: `Текст ${CHANNEL_LABELS[channelKey]} перевищує ${limit} символів`, warning: null }
        }
      }

      for (const b of config.buttons ?? []) {
        if (!b.label.trim()) return { error: 'Кожна кнопка повинна мати текст', warning: null }
        if (b.actionType === 'link' && !b.url?.trim()) return { error: 'Кнопка-посилання повинна мати URL', warning: null }
      }
    } else if (node.type === 'action') {
      if (!config.action_type) return { error: 'Кожна дія повинна мати тип', warning: null }
      if (config.action_type === 'set_tag' && !config.payload?.tag_id) return { error: 'Дія «Тег» повинна мати обраний тег', warning: null }
      if (config.action_type === 'set_variable' && !config.payload?.variable_def_id)
        return { error: 'Дія «Змінна» повинна мати обрану змінну', warning: null }
    } else if (node.type === 'ai') {
      // Rules are optional; context is what the model can't work without.
      if (!config.context?.trim()) return { error: 'AI-вузол повинен мати заповнений контекст', warning: null }
    } else if (node.type === 'conversion') {
      if (!config.stage_id) return { error: 'Вузол «Логічна конверсія» повинен мати обраний етап воронки', warning: null }
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return { error: 'Ребро посилається на неіснуючий вузол', warning: null }
  }

  return { error: null, warning }
}

// ---------- Custom node views ----------

// Same inline-edit pattern as the funnel title: reads as plain text until
// hovered, click to edit, Enter/blur commits, Escape cancels. Sits under the
// type badge so the coloured badge itself is untouched.
function NodeLabel({ value, placeholder, onChange }: { value?: string; placeholder: string; onChange: (next: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Enter and Escape both unmount the input, which can fire blur right after.
  const handled = useRef(false)

  function commit(next: string) {
    setEditing(false)
    const trimmed = next.trim()
    if (trimmed !== (value ?? '').trim()) onChange(trimmed)
  }

  if (editing) {
    return (
      <input
        className="input nodrag node-label-input"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (handled.current) {
            handled.current = false
            return
          }
          commit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handled.current = true
            commit(draft)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            handled.current = true
            setEditing(false)
          }
        }}
        aria-label="Назва вузла"
      />
    )
  }

  return (
    <button
      type="button"
      className="node-label-button nodrag"
      onClick={() => {
        setDraft(value ?? '')
        setEditing(true)
      }}
      title="Перейменувати вузол"
    >
      <span className={`node-label-text${(value ?? '').trim() ? '' : ' is-empty'}`}>{(value ?? '').trim() || placeholder}</span>
      <IconEdit size={11} aria-hidden="true" />
    </button>
  )
}

function EntryNodeView({ data }: NodeProps<NodeData>) {
  return (
    <div className="flow-node flow-node-entry">
      <div className="flow-node-header">
        <span className="flow-node-badge badge-entry">Точка входу</span>
        <button type="button" className="flow-node-delete" onClick={data.onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
      <NodeLabel
        value={data.config.label}
        placeholder="Точка входу"
        onChange={(label) => data.onChange({ label })}
      />
      <p className="flow-node-hint">Telegram · FBM · WhatsApp — клікніть, щоб налаштувати</p>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const CHANNEL_TABS: { key: ChannelKey; label: string }[] = [
  { key: 'telegram', label: 'Telegram' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'fbm', label: 'FB Messenger' },
]

const CHANNEL_FORMAT_MARKS: Record<ChannelKey, { delim: string; label: string; title: string }[]> = {
  telegram: [
    { delim: '*', label: 'Ж', title: 'Жирний' },
    { delim: '_', label: 'К', title: 'Курсив' },
    { delim: '`', label: '</>', title: 'Код' },
    { delim: '||', label: '‖', title: 'Спойлер' },
  ],
  whatsapp: [
    { delim: '*', label: 'Ж', title: 'Жирний' },
    { delim: '_', label: 'К', title: 'Курсив' },
    { delim: '~', label: 'S', title: 'Закреслений' },
    { delim: '```', label: '</>', title: 'Моноширинний' },
  ],
  fbm: [],
}

const ATTACHMENT_TYPES: { type: AttachmentType; label: string; icon: typeof IconImage; color: string }[] = [
  { type: 'photo', label: 'Фото', icon: IconImage, color: '#60a5fa' },
  { type: 'video', label: 'Відео', icon: IconVideo, color: '#a78bfa' },
  { type: 'video_note', label: 'Кружок', icon: IconVideoNote, color: '#34d399' },
  { type: 'audio', label: 'Аудіо', icon: IconMusic, color: '#fbbf24' },
  { type: 'animation', label: 'GIF', icon: IconBolt, color: '#f472b6' },
  { type: 'document', label: 'Файл', icon: IconFile, color: '#60a5fa' },
  { type: 'voice', label: 'Голосове', icon: IconMic, color: '#2dd4bf' },
  { type: 'poll', label: 'Опитування', icon: IconPoll, color: '#fb923c' },
]

// Telegram supports all 8; WhatsApp Cloud API and the Messenger Send API
// each only accept a subset (no video-note/voice/GIF-as-its-own-type/poll).
const CHANNEL_ATTACHMENT_TYPES: Record<ChannelKey, AttachmentType[]> = {
  telegram: ['photo', 'video', 'video_note', 'audio', 'animation', 'document', 'voice', 'poll'],
  whatsapp: ['photo', 'video', 'audio', 'document'],
  fbm: ['photo', 'video', 'audio', 'document'],
}

// Ukrainian noun-plural agreement for "вкладення" (nominative singular AND
// nominative plural 2-4 share the same form; only 5+/11-14 take genitive
// plural "вкладень") — used only for the sync-skip warning text below.
function pluralAttachments(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'вкладень'
  if (mod10 === 1) return 'вкладення'
  if (mod10 >= 2 && mod10 <= 4) return 'вкладення'
  return 'вкладень'
}

// Copies one channel's content into another: text (truncated with a warning
// if it overflows the target's shorter limit) plus only the attachment
// blocks the target channel actually supports (the rest are dropped with a
// warning naming how many and why). Buttons aren't touched here — they live
// at the node level already, shared across all three channels as-is.
function syncChannelContent(sourceConfig: ChannelConfig, targetKey: ChannelKey): { config: ChannelConfig; warnings: string[] } {
  const warnings: string[] = []
  const targetLimit = MESSAGE_CHAR_LIMITS[targetKey]

  let text = textBlockOf(sourceConfig).text
  if (text.length > targetLimit) {
    text = text.slice(0, targetLimit)
    warnings.push(`текст обрізано під ліміт ${CHANNEL_LABELS[targetKey]} (${targetLimit} символів), перевірте вручну`)
  }

  const allowedTypes = CHANNEL_ATTACHMENT_TYPES[targetKey]
  const sourceAttachments = sourceConfig.blocks.filter((b): b is AttachmentBlock => b.kind === 'attachment')
  const copyable = sourceAttachments.filter((b) => allowedTypes.includes(b.type))
  const skipped = sourceAttachments.filter((b) => !allowedTypes.includes(b.type))

  if (skipped.length > 0) {
    const skippedLabels = [...new Set(skipped.map((b) => ATTACHMENT_TYPES.find((a) => a.type === b.type)?.label ?? b.type))]
    warnings.push(
      `не скопійовано ${skipped.length} ${pluralAttachments(skipped.length)} (${skippedLabels.join(', ')}) — не підтримується каналом ${CHANNEL_LABELS[targetKey]}`,
    )
  }

  const blocks: ContentBlock[] = [{ id: TEXT_BLOCK_ID, kind: 'text', text }, ...copyable.map((b) => ({ ...b }))]

  return { config: { formatting: defaultFormattingFor(targetKey), blocks }, warnings }
}

function acceptFor(type: AttachmentType): string {
  if (type === 'photo') return 'image/*'
  if (type === 'video' || type === 'video_note') return 'video/*'
  if (type === 'animation') return 'image/gif,video/*'
  if (type === 'audio' || type === 'voice') return 'audio/*'
  return '*/*'
}

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)

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

// Toggle behaviour for the formatting toolbar: clicking a mark on a
// selection already wrapped in exactly that mark removes it again instead
// of piling on more delimiters; otherwise it wraps the selection with a new
// outermost pair, so re-selecting an already-marked span and applying a
// *different* mark nests cleanly (e.g. *_text_* — bold containing italic)
// rather than producing garbled, invalid combinations.
function toggleMark(
  delim: string,
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { text: string; start: number; end: number } {
  const selected = value.slice(selectionStart, selectionEnd)
  const before = value.slice(Math.max(0, selectionStart - delim.length), selectionStart)
  const after = value.slice(selectionEnd, selectionEnd + delim.length)

  if (before === delim && after === delim) {
    const text = value.slice(0, selectionStart - delim.length) + selected + value.slice(selectionEnd + delim.length)
    return { text, start: selectionStart - delim.length, end: selectionEnd - delim.length }
  }

  if (selected.startsWith(delim) && selected.endsWith(delim) && selected.length >= delim.length * 2) {
    const inner = selected.slice(delim.length, selected.length - delim.length)
    const text = value.slice(0, selectionStart) + inner + value.slice(selectionEnd)
    return { text, start: selectionStart, end: selectionStart + inner.length }
  }

  const text = value.slice(0, selectionStart) + delim + selected + delim + value.slice(selectionEnd)
  return { text, start: selectionStart + delim.length, end: selectionEnd + delim.length }
}

function AttachmentDropzone({
  attachment,
  onUploaded,
  accept,
}: {
  attachment: { type: AttachmentType; url: string; filename?: string }
  onUploaded: (url: string, filename: string) => void
  accept: string
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`Файл завеликий (макс. ${MAX_UPLOAD_MB}MB)`)
      return
    }
    setUploading(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setUploading(false)
      return
    }

    try {
      const dataBase64 = await blobToBase64(file)
      const res = await fetch('/.netlify/functions/upload-attachment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64 }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося завантажити файл')
      } else {
        onUploaded(data.url, data.filename ?? file.name)
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="nodrag">
      <div
        className={`msg-dropzone nodrag${dragOver ? ' drag-over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) handleFile(file)
        }}
      >
        {uploading ? (
          <IconSpinner size={16} />
        ) : attachment.url ? (
          attachment.type === 'photo' ? (
            <img src={attachment.url} alt="" className="msg-attachment-thumb" />
          ) : attachment.type === 'video' || attachment.type === 'video_note' ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={attachment.url} className="msg-attachment-thumb" muted />
          ) : (
            <span className="msg-dropzone-filename">{attachment.filename ?? 'Файл завантажено'}</span>
          )
        ) : (
          <span className="msg-dropzone-hint">Перетягніть файл сюди або клікніть, щоб обрати</span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="nodrag"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
      </div>
      {error && (
        <span className="flow-node-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </div>
  )
}

function VoiceRecorder({
  attachment,
  onUploaded,
}: {
  attachment: { url: string; filename?: string }
  onUploaded: (url: string, filename: string) => void
}) {
  const [recording, setRecording] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function startRecording() {
    setError(null)
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Мікрофон недоступний у цьому браузері')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Telegram voice messages expect OGG/Opus — request it when the
      // browser supports it (Safari doesn't; falls back to its own default).
      const mimeType = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : undefined
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType ?? recorder.mimeType ?? 'audio/webm' })
        setRecordedBlob(blob)
        setPreviewUrl(URL.createObjectURL(blob))
        stream.getTracks().forEach((t) => t.stop())
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      setError('Не вдалося отримати доступ до мікрофона')
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  function discardRecording() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setRecordedBlob(null)
  }

  async function handleUpload() {
    if (!recordedBlob) return
    setUploading(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setUploading(false)
      return
    }

    try {
      const dataBase64 = await blobToBase64(recordedBlob)
      const ext = recordedBlob.type.includes('ogg') ? 'ogg' : recordedBlob.type.includes('mp4') ? 'm4a' : 'webm'
      const filename = `voice-${Date.now()}.${ext}`
      const res = await fetch('/.netlify/functions/upload-attachment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ filename, contentType: recordedBlob.type || 'audio/ogg', dataBase64 }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося завантажити запис')
      } else {
        onUploaded(data.url, data.filename ?? filename)
        discardRecording()
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setUploading(false)
    }
  }

  if (previewUrl) {
    return (
      <div className="nodrag msg-voice-recorder">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls src={previewUrl} className="nodrag" />
        <div className="msg-voice-actions nodrag">
          <button type="button" className="btn btn-primary nodrag" style={{ height: 30 }} disabled={uploading} onClick={handleUpload}>
            {uploading ? <IconSpinner size={13} /> : 'Зберегти'}
          </button>
          <button type="button" className="btn btn-ghost nodrag" style={{ height: 30 }} onClick={discardRecording}>
            Перезаписати
          </button>
        </div>
        {error && (
          <span className="flow-node-hint" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="nodrag msg-voice-recorder">
      {attachment.url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio controls src={attachment.url} className="nodrag" />
      )}
      <button
        type="button"
        className={`msg-voice-record-btn nodrag${recording ? ' recording' : ''}`}
        onClick={recording ? stopRecording : startRecording}
      >
        <IconMic size={14} />
        {recording ? 'Стоп' : attachment.url ? 'Записати заново' : 'Записати'}
      </button>
      {error && (
        <span className="flow-node-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </div>
  )
}

function AttachmentBlockEditor({
  block,
  onChange,
  onRemove,
}: {
  block: AttachmentBlock
  onChange: (patch: Partial<Pick<AttachmentBlock, 'url' | 'filename'>>) => void
  onRemove: () => void
}) {
  const meta = ATTACHMENT_TYPES.find((a) => a.type === block.type)

  return (
    <div className="msg-attachment-row nodrag">
      <div className="msg-attachment-row-header">
        <span className="msg-attachment-type" style={{ color: meta?.color }}>
          {meta?.label}
        </span>
        <button type="button" className="btn-icon-ghost nodrag" onClick={onRemove} aria-label="Прибрати вкладення">
          <IconTrash size={12} />
        </button>
      </div>
      {block.type === 'poll' ? (
        <input
          className="input nodrag"
          value={block.url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="Питання опитування"
        />
      ) : block.type === 'voice' ? (
        <VoiceRecorder attachment={block} onUploaded={(url, filename) => onChange({ url, filename })} />
      ) : (
        <AttachmentDropzone attachment={block} onUploaded={(url, filename) => onChange({ url, filename })} accept={acceptFor(block.type)} />
      )}
    </div>
  )
}

function ChannelEditor({
  channelKey,
  config,
  onChange,
}: {
  channelKey: ChannelKey
  config: ChannelConfig
  onChange: (patch: Partial<ChannelConfig>) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showAttachments, setShowAttachments] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const limit = MESSAGE_CHAR_LIMITS[channelKey]
  const marks = CHANNEL_FORMAT_MARKS[channelKey]
  const allowedTypes = CHANNEL_ATTACHMENT_TYPES[channelKey]
  const visibleAttachmentTypes = ATTACHMENT_TYPES.filter((a) => allowedTypes.includes(a.type))
  const textBlock = textBlockOf(config)
  const overLimit = textBlock.text.length > limit

  // Auto-resize: grows with content instead of scrolling internally.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [textBlock.text])

  function updateBlocks(next: ContentBlock[]) {
    onChange({ blocks: next })
  }

  function updateTextBlock(patch: Partial<Pick<TextBlock, 'text'>>) {
    updateBlocks(config.blocks.map((b) => (b.kind === 'text' ? { ...b, ...patch } : b)))
  }

  function updateAttachmentBlock(blockId: string, patch: Partial<Pick<AttachmentBlock, 'url' | 'filename'>>) {
    updateBlocks(config.blocks.map((b) => (b.kind === 'attachment' && b.id === blockId ? { ...b, ...patch } : b)))
  }

  function removeBlock(blockId: string) {
    updateBlocks(config.blocks.filter((b) => b.id !== blockId))
  }

  function moveBlock(from: number, to: number) {
    if (from === to) return
    const next = [...config.blocks]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    updateBlocks(next)
  }

  function applyMark(delim: string) {
    const el = textareaRef.current
    if (!el) return
    const { selectionStart, selectionEnd, value } = el
    const result = toggleMark(delim, value, selectionStart, selectionEnd)
    updateTextBlock({ text: result.text })
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(result.start, result.end)
    })
  }

  function addAttachment(type: AttachmentType) {
    updateBlocks([...config.blocks, { id: crypto.randomUUID().slice(0, 8), kind: 'attachment', type, url: '' }])
    setShowAttachments(false)
  }

  return (
    <>
      <div className="msg-blocks nodrag">
        {config.blocks.map((block, index) => (
          <div
            key={block.id}
            className={`msg-block nodrag${dragIndex === index ? ' dragging' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (dragIndex !== null) moveBlock(dragIndex, index)
              setDragIndex(null)
            }}
          >
            <span
              className="msg-block-grip nodrag"
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
              aria-label="Перетягнути для зміни порядку"
              title="Перетягнути для зміни порядку"
            >
              <IconGrip size={14} />
            </span>

            <div className="msg-block-content">
              {block.kind === 'text' ? (
                <>
                  {marks.length > 0 && (
                    <div className="msg-toolbar nodrag">
                      <span className="msg-toolbar-label">Виділіть текст для форматування:</span>
                      <div className="msg-toolbar-actions">
                        {marks.map((m) => (
                          <button
                            key={m.delim}
                            type="button"
                            className="msg-format-btn nodrag"
                            title={m.title}
                            onClick={() => applyMark(m.delim)}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    className="input textarea nodrag msg-textarea-auto"
                    value={block.text}
                    onChange={(e) => updateTextBlock({ text: e.target.value })}
                    placeholder="Текст повідомлення…"
                    rows={1}
                  />
                  <span className={`msg-char-count${overLimit ? ' over-limit' : ''}`}>
                    {block.text.length} / {limit}
                  </span>
                </>
              ) : (
                <AttachmentBlockEditor
                  block={block}
                  onChange={(patch) => updateAttachmentBlock(block.id, patch)}
                  onRemove={() => removeBlock(block.id)}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {showAttachments && (
        <div className="msg-attachment-grid nodrag">
          {visibleAttachmentTypes.map((a) => {
            const Icon = a.icon
            return (
              <button key={a.type} type="button" className="msg-attachment-item nodrag" onClick={() => addAttachment(a.type)}>
                <span className="msg-attachment-icon" style={{ '--attach-accent': a.color } as CSSProperties}>
                  <Icon size={18} />
                </span>
                {a.label}
              </button>
            )
          })}
        </div>
      )}

      <div className="msg-channel-footer nodrag">
        <button
          type="button"
          className="msg-attach-toggle nodrag"
          onClick={() => setShowAttachments((s) => !s)}
          aria-label={showAttachments ? 'Закрити вкладення' : 'Додати вкладення'}
        >
          {showAttachments ? <IconClose size={16} /> : <IconPlus size={16} />}
        </button>
      </div>
    </>
  )
}

function MessageNodeView({ id, data }: NodeProps<NodeData>) {
  const config = data.config
  const buttons = config.buttons ?? []
  const [activeChannel, setActiveChannel] = useState<ChannelKey>('telegram')
  const [syncWarnings, setSyncWarnings] = useState<string[] | null>(null)
  const updateNodeInternals = useUpdateNodeInternals()

  function selectChannel(channel: ChannelKey) {
    setActiveChannel(channel)
    setSyncWarnings(null)
  }

  // Each non-link button gets its own source Handle, added/removed
  // dynamically after the node's initial mount (and toggled by switching a
  // button between edge/link). React Flow only measures a node's handles at
  // mount (and when told to) — without this, new handles render but can't
  // actually be connected until something else forces a re-measure.
  const buttonHandleSignature = buttons.map((b) => `${b.id}:${b.actionType === 'link' ? 'link' : 'edge'}`).join('|')
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, buttonHandleSignature, updateNodeInternals])

  function updateChannel(channel: ChannelKey, patch: Partial<ChannelConfig>) {
    const current = normalizeChannelConfig(config.channels?.[channel], defaultFormattingFor(channel))
    data.onChange({
      channels: {
        telegram: normalizeChannelConfig(config.channels?.telegram, 'markdown_v2'),
        whatsapp: normalizeChannelConfig(config.channels?.whatsapp, 'whatsapp'),
        fbm: normalizeChannelConfig(config.channels?.fbm, 'none'),
        [channel]: { ...current, ...patch },
      },
    })
  }

  function addButton() {
    const newButton: FunnelButton = { id: crypto.randomUUID().slice(0, 8), label: '', actionType: 'edge' }
    data.onChange({ buttons: [...buttons, newButton] })
  }

  function updateButton(buttonId: string, patch: Partial<FunnelButton>) {
    data.onChange({ buttons: buttons.map((b) => (b.id === buttonId ? { ...b, ...patch } : b)) })
  }

  function removeButton(buttonId: string) {
    data.onChange({ buttons: buttons.filter((b) => b.id !== buttonId) })
  }

  // Copies the active tab's content into the other two, translating each to
  // that channel's own limit/attachment support (see syncChannelContent).
  function handleSync() {
    const sourceConfig = normalizeChannelConfig(config.channels?.[activeChannel], defaultFormattingFor(activeChannel))
    const targets = CHANNEL_TABS.map((t) => t.key).filter((key) => key !== activeChannel)

    const nextChannels = {
      telegram: normalizeChannelConfig(config.channels?.telegram, 'markdown_v2'),
      whatsapp: normalizeChannelConfig(config.channels?.whatsapp, 'whatsapp'),
      fbm: normalizeChannelConfig(config.channels?.fbm, 'none'),
    }
    const warnings: string[] = []
    for (const target of targets) {
      const result = syncChannelContent(sourceConfig, target)
      nextChannels[target] = result.config
      warnings.push(...result.warnings.map((w) => `${CHANNEL_LABELS[target]}: ${w}`))
    }

    data.onChange({ channels: nextChannels })
    setSyncWarnings(warnings.length > 0 ? warnings : null)
  }

  const activeConfig = normalizeChannelConfig(config.channels?.[activeChannel], defaultFormattingFor(activeChannel))

  return (
    <div className="flow-node flow-node-message">
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-header">
        <span className="flow-node-badge badge-message">Повідомлення</span>
        <button type="button" className="flow-node-copy" onClick={data.onDuplicate} aria-label="Дублювати" title="Дублювати">
          <IconDuplicate size={13} />
        </button>
        <button type="button" className="flow-node-delete" onClick={data.onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
      <NodeLabel
        value={data.config.label}
        placeholder="Повідомлення"
        onChange={(label) => data.onChange({ label })}
      />

      <div className="msg-channel-tabs nodrag">
        {CHANNEL_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`msg-channel-tab nodrag${activeChannel === t.key ? ' active' : ''}`}
            onClick={() => selectChannel(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="msg-sync-btn nodrag"
        onClick={handleSync}
        title={`Скопіювати текст і вкладення з ${CHANNEL_LABELS[activeChannel]} в інші дві вкладки`}
      >
        <IconSync size={12} />
        Синхронізувати з {CHANNEL_LABELS[activeChannel]}
      </button>

      {syncWarnings && (
        <div className="msg-sync-warnings nodrag">
          <div className="msg-sync-warnings-header">
            <span>Синхронізовано з попередженнями</span>
            <button type="button" className="btn-icon-ghost nodrag" onClick={() => setSyncWarnings(null)} aria-label="Закрити попередження">
              <IconClose size={12} />
            </button>
          </div>
          <ul className="msg-sync-warnings-list">
            {syncWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <ChannelEditor
        key={activeChannel}
        channelKey={activeChannel}
        config={activeConfig}
        onChange={(patch) => updateChannel(activeChannel, patch)}
      />

      <div className="flow-node-buttons">
        {buttons.map((b) => {
          const isLink = b.actionType === 'link'
          return (
            <div className="flow-node-button-row" key={b.id}>
              <div className="flow-node-button-main">
                <input
                  className="input nodrag"
                  value={b.label}
                  onChange={(e) => updateButton(b.id, { label: e.target.value })}
                  placeholder="Текст кнопки"
                />
                <select
                  className="input nodrag flow-node-button-type"
                  value={isLink ? 'link' : 'edge'}
                  onChange={(e) => updateButton(b.id, { actionType: e.target.value as 'edge' | 'link' })}
                  title="Тип кнопки"
                >
                  <option value="edge">Дія</option>
                  <option value="link">Лінк</option>
                </select>
                <button type="button" className="btn-icon-ghost nodrag" onClick={() => removeButton(b.id)} aria-label="Видалити кнопку">
                  <IconTrash size={12} />
                </button>
                {!isLink && <Handle type="source" position={Position.Right} id={b.id} className="flow-node-button-handle" />}
              </div>
              {isLink && (
                <input
                  className="input nodrag"
                  value={b.url ?? ''}
                  onChange={(e) => updateButton(b.id, { url: e.target.value })}
                  placeholder="https://…"
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="msg-footer nodrag">
        <button type="button" className="btn btn-ghost flow-node-add-button nodrag" onClick={addButton}>
          <IconPlus size={13} />
          Кнопка
        </button>
      </div>

      {buttons.length > 0 && (
        <label className="msg-clear-buttons nodrag" title="Після натискання клавіатура зникне з цього повідомлення в Telegram">
          <input
            type="checkbox"
            checked={!!config.clear_buttons_after_use}
            onChange={(e) => data.onChange({ clear_buttons_after_use: e.target.checked })}
          />
          <span>Прибирати кнопки після використання</span>
        </label>
      )}
      {buttons.length === 0 && <Handle type="source" position={Position.Right} />}
    </div>
  )
}

function ActionNodeView({ data }: NodeProps<NodeData>) {
  const config = data.config
  const kind = actionUiKind(config.action_type)
  const elements = useContext(ElementsContext)

  function handleKindChange(newKind: string) {
    if (newKind === 'tag') data.onChange({ action_type: 'set_tag', payload: { tag_id: config.payload?.tag_id ?? '' } })
    else if (newKind === 'variable')
      data.onChange({
        action_type: 'set_variable',
        payload: { variable_def_id: config.payload?.variable_def_id ?? '', value: config.payload?.value ?? '' },
      })
    else if (newKind === 'subscribe') data.onChange({ action_type: 'subscribe', payload: undefined })
    else if (newKind === 'unsubscribe') data.onChange({ action_type: 'unsubscribe', payload: undefined })
    else if (newKind === 'chat') data.onChange({ action_type: 'open_chat', payload: undefined })
  }

  return (
    <div className="flow-node flow-node-action">
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-header">
        <span className="flow-node-badge badge-action">Дія</span>
        <button type="button" className="flow-node-copy" onClick={data.onDuplicate} aria-label="Дублювати" title="Дублювати">
          <IconDuplicate size={13} />
        </button>
        <button type="button" className="flow-node-delete" onClick={data.onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
      <NodeLabel
        value={data.config.label}
        placeholder="Дія"
        onChange={(label) => data.onChange({ label })}
      />
      <select className="input nodrag" value={kind} onChange={(e) => handleKindChange(e.target.value)}>
        <option value="">Оберіть дію</option>
        <option value="tag">Тег</option>
        <option value="variable">Змінна</option>
        <option value="subscribe">Підписка</option>
        <option value="unsubscribe">Відписка</option>
        <option value="chat">Чат</option>
      </select>

      {kind === 'tag' && (
        <TagPicker
          value={config.payload?.tag_id ?? ''}
          onChange={(tagId) => data.onChange({ payload: { ...config.payload, tag_id: tagId } })}
          tags={elements?.tags ?? []}
          createTag={elements?.createTag}
        />
      )}
      {kind === 'variable' && (
        <>
          <VariableDefPicker
            value={config.payload?.variable_def_id ?? ''}
            onChange={(variableDefId) => data.onChange({ payload: { ...config.payload, variable_def_id: variableDefId } })}
            variableDefs={elements?.variableDefs ?? []}
            createVariableDef={elements?.createVariableDef}
          />
          <input
            className="input nodrag"
            value={config.payload?.value ?? ''}
            onChange={(e) => data.onChange({ payload: { ...config.payload, value: e.target.value } })}
            placeholder="Значення"
          />
        </>
      )}
      {kind === 'chat' && (
        <select
          className="input nodrag"
          value={config.action_type ?? 'open_chat'}
          onChange={(e) => data.onChange({ action_type: e.target.value as ActionType })}
        >
          <option value="open_chat">Відкрити</option>
          <option value="close_chat">Закрити</option>
        </select>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

// No source Handle: an ai node is a terminus for now — it parks the thread in
// AI mode and the model handles every following message. Exit edges arrive
// together with tool-calling.
// Collapsible settings row. A real <button> carrying aria-expanded (not a
// clickable div), and the header icon is decorative beside its visible label
// so it's aria-hidden. Open state is set directly rather than waiting on the
// CSS transition, so rapid clicks can't desync it.
function AiSection({
  sectionId,
  icon: Icon,
  label,
  preview,
  open,
  onToggle,
  children,
}: {
  sectionId: string
  icon: typeof IconFile
  label: string
  preview: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={`ai-section${open ? ' open' : ''}`}>
      <button
        type="button"
        className="ai-section-header nodrag"
        onClick={onToggle}
        aria-expanded={open}
        // Only referenced while the body is actually in the DOM — a collapsed
        // section would otherwise point aria-controls at a missing id.
        aria-controls={open ? sectionId : undefined}
      >
        <Icon size={13} aria-hidden="true" />
        <span className="ai-section-label">{label}</span>
        <span className="ai-section-preview">{open ? '' : preview}</span>
        <IconChevronRight size={12} className="ai-section-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="ai-section-body" id={sectionId}>
          {children}
        </div>
      )}
    </div>
  )
}

function previewOf(value: string | undefined, empty: string): string {
  const text = (value ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return empty
  return text.length > 28 ? `${text.slice(0, 28)}…` : text
}

const DELAY_DEFAULT_TZ = 'Europe/Kyiv'

// Common IANA zones; the saved value is appended if it isn't listed, so a
// node configured with any other zone keeps it instead of being reset.
const DELAY_TIMEZONES = [
  'Europe/Kyiv',
  'Europe/Warsaw',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Istanbul',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'Asia/Dubai',
  'Asia/Jerusalem',
  'Asia/Almaty',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
]

function delaySummary(config: NodeConfig): string {
  if (config.delay_mode === 'exact') {
    return `о ${config.delay_time ?? '09:00'} · ${config.delay_tz ?? DELAY_DEFAULT_TZ}`
  }
  const h = Number(config.delay_hours) || 0
  const m = Number(config.delay_minutes) || 0
  if (h === 0 && m === 0) return 'без затримки'
  return `через ${h > 0 ? `${h} год ` : ''}${m > 0 ? `${m} хв` : ''}`.trim()
}

// One target, one source: a delay always continues to exactly one next node.
function DelayNodeView({ data }: NodeProps<NodeData>) {
  const config = data.config
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<NodeConfig>(config)

  function open() {
    setDraft({
      delay_mode: config.delay_mode ?? 'relative',
      delay_hours: config.delay_hours ?? 0,
      delay_minutes: config.delay_minutes ?? 30,
      delay_time: config.delay_time ?? '09:00',
      delay_tz: config.delay_tz ?? DELAY_DEFAULT_TZ,
    })
    setEditing(true)
  }

  const zones = draft.delay_tz && !DELAY_TIMEZONES.includes(draft.delay_tz) ? [...DELAY_TIMEZONES, draft.delay_tz] : DELAY_TIMEZONES

  return (
    <div className="flow-node flow-node-delay">
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-header">
        <span className="flow-node-badge badge-delay">Затримка</span>
        <button type="button" className="flow-node-copy" onClick={data.onDuplicate} aria-label="Дублювати" title="Дублювати">
          <IconDuplicate size={13} />
        </button>
        <button type="button" className="flow-node-delete" onClick={data.onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
      <NodeLabel value={config.label} placeholder="Затримка" onChange={(label) => data.onChange({ label })} />

      <button type="button" className="delay-summary nodrag" onClick={open}>
        <IconStopwatch size={15} aria-hidden="true" />
        <span>{delaySummary(config)}</span>
      </button>

      <Handle type="source" position={Position.Right} />

      {/* Portalled to <body>: React Flow's viewport pane carries a CSS
          transform, and a transformed ancestor makes position:fixed resolve
          against it instead of the viewport — the modal would be clipped and
          scaled by the canvas zoom. */}
      {editing && createPortal(
        <div className="modal-backdrop nodrag" onClick={() => setEditing(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Налаштування затримки">
            <h3 className="modal-title">Налаштування затримки</h3>

            <div className="modal-tabs">
              <button
                type="button"
                className={`modal-tab${draft.delay_mode !== 'exact' ? ' active' : ''}`}
                onClick={() => setDraft((d) => ({ ...d, delay_mode: 'relative' }))}
              >
                Затримка
              </button>
              <button
                type="button"
                className={`modal-tab${draft.delay_mode === 'exact' ? ' active' : ''}`}
                onClick={() => setDraft((d) => ({ ...d, delay_mode: 'exact' }))}
              >
                Точний час
              </button>
            </div>

            {draft.delay_mode === 'exact' ? (
              <>
                <div className="field">
                  <label htmlFor="delay-time">Час відправки</label>
                  <input
                    id="delay-time"
                    className="input"
                    type="time"
                    value={draft.delay_time ?? '09:00'}
                    onChange={(e) => setDraft((d) => ({ ...d, delay_time: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="delay-tz">Часовий пояс</label>
                  <select
                    id="delay-tz"
                    className="input"
                    value={draft.delay_tz ?? DELAY_DEFAULT_TZ}
                    onChange={(e) => setDraft((d) => ({ ...d, delay_tz: e.target.value }))}
                  >
                    {zones.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="flow-node-hint">Чекає до найближчого настання цього часу — сьогодні, якщо ще не минув, інакше завтра.</p>
              </>
            ) : (
              <>
                <div className="modal-row">
                  <div className="field">
                    <label htmlFor="delay-hours">Години</label>
                    <input
                      id="delay-hours"
                      className="input"
                      type="number"
                      min={0}
                      max={720}
                      value={draft.delay_hours ?? 0}
                      onChange={(e) => setDraft((d) => ({ ...d, delay_hours: Math.max(0, Number(e.target.value) || 0) }))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="delay-minutes">Хвилини</label>
                    <input
                      id="delay-minutes"
                      className="input"
                      type="number"
                      min={0}
                      max={59}
                      value={draft.delay_minutes ?? 0}
                      onChange={(e) => setDraft((d) => ({ ...d, delay_minutes: Math.max(0, Number(e.target.value) || 0) }))}
                    />
                  </div>
                </div>
                <p className="flow-node-hint">Відлік починається з моменту, коли лід потрапляє в цей вузол.</p>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                Скасувати
              </button>
              <button
                type="button"
                className="btn-save-gradient"
                onClick={() => {
                  data.onChange(draft)
                  setEditing(false)
                }}
              >
                Зберегти
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function conditionSummary(config: NodeConfig): string {
  const count = (config.conditions ?? []).length
  if (count === 0) return 'Умови не задані'
  const joiner = config.combinator === 'or' ? 'АБО' : 'І'
  const noun = count === 1 ? 'умова' : count < 5 ? 'умови' : 'умов'
  return `${count} ${noun} · ${joiner}`
}

function ConditionNodeView({ data }: NodeProps<NodeData>) {
  const config = data.config
  const elements = useContext(ElementsContext)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<NodeConfig>(config)

  function open() {
    setDraft({
      combinator: config.combinator ?? 'and',
      conditions: (config.conditions ?? []).map((c) => ({ ...c })),
    })
    setEditing(true)
  }

  const rules = draft.conditions ?? []

  function patchRule(id: string, patch: Partial<ConditionRule>) {
    setDraft((d) => ({ ...d, conditions: (d.conditions ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
  }

  function removeRule(id: string) {
    setDraft((d) => ({ ...d, conditions: (d.conditions ?? []).filter((c) => c.id !== id) }))
  }

  function addRule() {
    setDraft((d) => ({
      ...d,
      conditions: [...(d.conditions ?? []), { id: crypto.randomUUID(), kind: 'tag', tag_op: 'has', tag_id: '' }],
    }))
  }

  return (
    <div className="flow-node flow-node-condition">
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-header">
        <span className="flow-node-badge badge-condition">Умова</span>
        <button type="button" className="flow-node-copy" onClick={data.onDuplicate} aria-label="Дублювати" title="Дублювати">
          <IconDuplicate size={13} />
        </button>
        <button type="button" className="flow-node-delete" onClick={data.onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
      <NodeLabel value={config.label} placeholder="Умова" onChange={(label) => data.onChange({ label })} />

      <button type="button" className="condition-summary nodrag" onClick={open}>
        <IconBranch size={15} aria-hidden="true" />
        <span>{conditionSummary(config)}</span>
      </button>

      <div className="cond-node-outputs">
        {CONDITION_EXITS.map((exit) => (
          <div className={`cond-node-output cond-node-output-${exit.tone}`} key={exit.id}>
            <span>{exit.label}</span>
            <Handle type="source" position={Position.Right} id={exit.id} className="flow-node-button-handle" />
          </div>
        ))}
      </div>

      {/* Portalled to <body>: React Flow's viewport pane carries a CSS
          transform, and a transformed ancestor makes position:fixed resolve
          against it instead of the viewport — the modal would be clipped and
          scaled by the canvas zoom. */}
      {editing &&
        createPortal(
          <div className="modal-backdrop nodrag" onClick={() => setEditing(false)}>
            <div
              className="modal-card modal-card-wide"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Налаштування умови"
            >
              <h3 className="modal-title">Налаштування умови</h3>

              <div className="modal-tabs" role="group" aria-label="Комбінація умов">
                <button
                  type="button"
                  className={`modal-tab${draft.combinator !== 'or' ? ' active' : ''}`}
                  aria-pressed={draft.combinator !== 'or'}
                  onClick={() => setDraft((d) => ({ ...d, combinator: 'and' }))}
                >
                  І
                </button>
                <button
                  type="button"
                  className={`modal-tab${draft.combinator === 'or' ? ' active' : ''}`}
                  aria-pressed={draft.combinator === 'or'}
                  onClick={() => setDraft((d) => ({ ...d, combinator: 'or' }))}
                >
                  АБО
                </button>
              </div>
              <p className="flow-node-hint">
                {draft.combinator === 'or'
                  ? 'Лід піде гілкою «Так», якщо виконана хоча б одна умова.'
                  : 'Лід піде гілкою «Так», лише якщо виконані всі умови.'}
              </p>

              <div className="cond-list">
                {rules.map((rule) => (
                  <div className="cond-item" key={rule.id}>
                    <div className="cond-item-head">
                      <select
                        className="input nodrag"
                        aria-label="Тип умови"
                        value={rule.kind}
                        onChange={(e) => {
                          const kind = e.target.value as ConditionKind
                          // Switching type starts that type's fields fresh —
                          // a leftover tag_id would otherwise be saved with a
                          // variable rule and vice versa.
                          patchRule(
                            rule.id,
                            kind === 'variable'
                              ? { kind, var_op: 'eq', variable_def_id: '', value: '', tag_op: undefined, tag_id: undefined }
                              : { kind, tag_op: 'has', tag_id: '', var_op: undefined, variable_def_id: undefined, value: undefined },
                          )
                        }}
                      >
                        <option value="tag">Тег</option>
                        <option value="variable">Змінна</option>
                      </select>
                      <button
                        type="button"
                        className="cond-item-delete nodrag"
                        onClick={() => removeRule(rule.id)}
                        aria-label="Видалити умову"
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>

                    {rule.kind === 'variable' ? (
                      <>
                        <select
                          className="input nodrag"
                          aria-label="Оператор"
                          value={rule.var_op ?? 'eq'}
                          onChange={(e) => patchRule(rule.id, { var_op: e.target.value as ConditionRule['var_op'] })}
                        >
                          {VARIABLE_OPERATORS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </select>
                        <select
                          className="input nodrag"
                          aria-label="Змінна"
                          value={rule.variable_def_id ?? ''}
                          onChange={(e) => patchRule(rule.id, { variable_def_id: e.target.value })}
                        >
                          <option value="">Оберіть змінну</option>
                          {(elements?.variableDefs ?? []).map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                        </select>
                        <input
                          className="input nodrag"
                          aria-label="Значення для порівняння"
                          placeholder="Значення"
                          value={rule.value ?? ''}
                          onChange={(e) => patchRule(rule.id, { value: e.target.value })}
                        />
                      </>
                    ) : (
                      <>
                        <select
                          className="input nodrag"
                          aria-label="Оператор"
                          value={rule.tag_op ?? 'has'}
                          onChange={(e) => patchRule(rule.id, { tag_op: e.target.value as ConditionRule['tag_op'] })}
                        >
                          {TAG_OPERATORS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </select>
                        <select
                          className="input nodrag"
                          aria-label="Тег"
                          value={rule.tag_id ?? ''}
                          onChange={(e) => patchRule(rule.id, { tag_id: e.target.value })}
                        >
                          <option value="">Оберіть тег</option>
                          {(elements?.tags ?? []).map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {rules.length === 0 && <p className="flow-node-hint">Без умов лід завжди піде гілкою «Так».</p>}

              <button type="button" className="btn btn-ghost cond-add nodrag" onClick={addRule}>
                <IconPlus size={14} aria-hidden="true" /> Додати умову
              </button>

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                  Скасувати
                </button>
                <button
                  type="button"
                  className="btn-save-gradient"
                  onClick={() => {
                    data.onChange({ combinator: draft.combinator ?? 'and', conditions: draft.conditions ?? [] })
                    setEditing(false)
                  }}
                >
                  Зберегти
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

// One target, one source: entering the node marks the stage and the lead
// continues straight on, so there's nothing to branch or wait on — the same
// unconditional single-exit shape a delay has.
function ConversionNodeView({ data }: NodeProps<NodeData>) {
  const config = data.config
  const elements = useContext(ElementsContext)
  const stageName = elements?.stages.find((s) => s.id === config.stage_id)?.name

  return (
    <div className="flow-node flow-node-conversion">
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-header">
        <span className="flow-node-badge badge-conversion">Логічна конверсія</span>
        <button type="button" className="flow-node-copy" onClick={data.onDuplicate} aria-label="Дублювати" title="Дублювати">
          <IconDuplicate size={13} />
        </button>
        <button type="button" className="flow-node-delete" onClick={data.onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
      <NodeLabel value={config.label} placeholder="Логічна конверсія" onChange={(label) => data.onChange({ label })} />

      <label className="node-inspector-label">Який етап аналітичної воронки цей вузол представляє</label>
      <StagePicker
        value={config.stage_id ?? ''}
        onChange={(stage_id) => data.onChange({ stage_id })}
        stages={elements?.stages ?? []}
        createStage={elements?.createStage}
        updateStageConversion={elements?.updateStageConversion}
      />

      <p className="flow-node-hint">
        {stageName
          ? `Лід позначається як «${stageName}» і одразу йде далі.`
          : 'Оберіть етап — без нього вузол не збережеться.'}
      </p>

      <Handle type="source" position={Position.Right} />
    </div>
  )
}

function AiNodeView({ id, data }: NodeProps<NodeData>) {
  const config = data.config
  const openRouterModels = useOpenRouterModels(true)
  const tasks = config.tasks ?? []

  // Context/rules start collapsed: the node otherwise runs the height of the
  // canvas, and these are write-once settings next to the list you actually
  // work in (progressive disclosure).
  const [openSections, setOpenSections] = useState({ context: false, rules: false, model: false, advanced: false })
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [pendingTasks, setPendingTasks] = useState<AiTask[] | null>(null)

  function toggleSection(key: keyof typeof openSections) {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function updateTasks(next: AiTask[]) {
    data.onChange({ tasks: next })
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenError(null)
    setPendingTasks(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setGenError('Сесія недійсна, увійдіть знову')
      setGenerating(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/ai-generate-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ context: config.context ?? '', rules: config.rules ?? '', model: config.model ?? '' }),
      })
      // Not every failure answers in JSON: when a function is killed at the
      // platform's time limit the body is a plain-text 500, and calling
      // res.json() on it threw — which the catch below then reported as a
      // "network error", hiding the real cause.
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        setGenError(payload?.error ?? `Сервер повернув помилку (${res.status}). Спробуйте ще раз.`)
      } else if (!payload) {
        setGenError('Сервер повернув неочікувану відповідь. Спробуйте ще раз.')
      } else {
        const generated: AiTask[] = (payload.tasks ?? []).map((t: { description: string }) => ({
          id: crypto.randomUUID().slice(0, 8),
          description: t.description,
        }))
        // Nothing to lose when the list is empty — apply straight away and
        // only ask replace-or-append when it would overwrite real work.
        if (tasks.length === 0) updateTasks(generated)
        else setPendingTasks(generated)
      }
    } catch {
      setGenError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setGenerating(false)
    }
  }

  function addTask() {
    updateTasks([...tasks, { id: crypto.randomUUID().slice(0, 8), description: '' }])
  }

  function updateTask(taskId: string, description: string) {
    updateTasks(tasks.map((t) => (t.id === taskId ? { ...t, description } : t)))
  }

  function removeTask(taskId: string) {
    updateTasks(tasks.filter((t) => t.id !== taskId))
  }

  // Arrows rather than drag: the message blocks' HTML5 drag is unreliable
  // inside a React Flow node, and order here is what the model is told to
  // work through.
  function moveTask(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= tasks.length) return
    const next = [...tasks]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    updateTasks(next)
  }

  return (
    <div className="flow-node flow-node-ai">
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-header">
        <span className="flow-node-badge badge-ai">AI</span>
        <button type="button" className="flow-node-copy" onClick={data.onDuplicate} aria-label="Дублювати" title="Дублювати">
          <IconDuplicate size={13} />
        </button>
        <button type="button" className="flow-node-delete" onClick={data.onDelete} aria-label="Видалити">
          <IconTrash size={13} />
        </button>
      </div>
      <NodeLabel
        value={data.config.label}
        placeholder="AI"
        onChange={(label) => data.onChange({ label })}
      />
      <div className="ai-settings-group">
        <AiSection
          sectionId={`ai-context-body-${id}`}
          icon={IconFile}
          label="Контекст"
          preview={previewOf(config.context, 'не заповнено')}
          open={openSections.context}
          onToggle={() => toggleSection('context')}
        >
          <textarea
            id={`ai-context-${id}`}
            className="input nodrag"
            rows={4}
            value={config.context ?? ''}
            onChange={(e) => data.onChange({ context: e.target.value })}
            placeholder="Хто клієнт, про що продукт, у якій ситуації відбувається розмова"
          />
        </AiSection>

        <AiSection
          sectionId={`ai-rules-body-${id}`}
          icon={IconShield}
          label="Правила"
          preview={previewOf(config.rules, 'не заповнено')}
          open={openSections.rules}
          onToggle={() => toggleSection('rules')}
        >
          <textarea
            id={`ai-rules-${id}`}
            className="input nodrag"
            rows={4}
            value={config.rules ?? ''}
            onChange={(e) => data.onChange({ rules: e.target.value })}
            placeholder="Чого не робити, обмеження, тон спілкування"
          />
        </AiSection>

        <AiSection
          sectionId={`ai-model-body-${id}`}
          icon={IconCpu}
          label="Модель"
          preview={previewOf(config.model, AI_DEFAULT_MODEL)}
          open={openSections.model}
          onToggle={() => toggleSection('model')}
        >
          <input
            id={`ai-model-${id}`}
            className="input nodrag"
            list={`ai-models-${id}`}
            value={config.model ?? ''}
            onChange={(e) => data.onChange({ model: e.target.value })}
            placeholder={AI_DEFAULT_MODEL}
            autoComplete="off"
          />
          {/* datalist gives native type-to-search over the ~400 live models
              without hand-rolling a combobox inside a draggable node. */}
          <datalist id={`ai-models-${id}`}>
            {openRouterModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <span className="flow-node-hint">
            {openRouterModels.length
              ? `${openRouterModels.length} моделей — почніть вводити для пошуку`
              : 'Завантаження списку моделей…'}
          </span>
        </AiSection>

        <AiSection
          sectionId={`ai-advanced-body-${id}`}
          icon={IconSettings}
          label="Розширені налаштування"
          preview={`${config.min_attempts_before_error ?? AI_DEFAULT_MIN_ATTEMPTS} спроби`}
          open={openSections.advanced}
          onToggle={() => toggleSection('advanced')}
        >
          <label className="node-inspector-label" htmlFor={`ai-attempts-${id}`}>
            Мінімум спроб перед ескалацією помилки
          </label>
          <input
            id={`ai-attempts-${id}`}
            className="input nodrag"
            type="number"
            min={1}
            max={10}
            value={config.min_attempts_before_error ?? AI_DEFAULT_MIN_ATTEMPTS}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              data.onChange({ min_attempts_before_error: Number.isFinite(n) && n >= 1 ? n : AI_DEFAULT_MIN_ATTEMPTS })
            }}
          />
          <span className="flow-node-hint">
            AI спробує уточнити питання цю кількість разів, перш ніж передати як помилку. Прохання ліда покликати
            людину передається одразу, без спроб.
          </span>

          <div className="node-inspector-toggle-row">
            <div>
              <span className="node-inspector-label" style={{ marginBottom: 0 }}>
                Пам'ять
              </span>
              <p className="flow-node-hint">
                Вимкнено — факти про ліда (remember_fact) спільні для всіх AI-вузлів ліда, як і зараз. Увімкнено —
                факти зберігаються окремо для цього вузла і не потрапляють в жоден інший AI-вузол, навіть в іншій
                воронці.
              </p>
            </div>
            <button
              type="button"
              className={`toggle ${config.memory_enabled ? 'on' : ''}`}
              onClick={() => data.onChange({ memory_enabled: !config.memory_enabled })}
              aria-pressed={!!config.memory_enabled}
              aria-label="Пам'ять окремо для цього вузла"
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </AiSection>
      </div>

      <div className="ai-tasks-header">
        <IconListChecks size={13} aria-hidden="true" />
        <span className="ai-tasks-title">AI Завдання</span>
        {tasks.length > 0 && <span className="ai-tasks-count">{tasks.length}</span>}
        <button
          type="button"
          className="btn-generate nodrag"
          onClick={handleGenerate}
          disabled={generating}
          title="Згенерувати завдання з контексту і правил"
        >
          {generating ? <IconSpinner size={12} /> : <IconSparkles size={12} aria-hidden="true" />}
          {generating ? 'Генерую…' : 'Згенерувати'}
        </button>
      </div>

      {genError && (
        <div className="ai-gen-error nodrag" role="alert">
          <IconAlert size={12} aria-hidden="true" />
          <span>{genError}</span>
        </div>
      )}

      {pendingTasks && (
        <div className="ai-gen-choice nodrag">
          <span>Згенеровано {pendingTasks.length}. Що зробити з поточними {tasks.length}?</span>
          <div className="ai-gen-choice-actions">
            <button
              type="button"
              className="btn btn-primary nodrag"
              onClick={() => {
                updateTasks(pendingTasks)
                setPendingTasks(null)
              }}
            >
              Замінити
            </button>
            <button
              type="button"
              className="btn btn-ghost nodrag"
              onClick={() => {
                updateTasks([...tasks, ...pendingTasks])
                setPendingTasks(null)
              }}
            >
              Додати
            </button>
            <button type="button" className="btn-icon-ghost nodrag" onClick={() => setPendingTasks(null)} aria-label="Скасувати">
              <IconClose size={13} />
            </button>
          </div>
        </div>
      )}
      <div className="ai-task-list nodrag">
        {tasks.map((task, index) => (
          <div className="ai-task-row" key={task.id}>
            <span className="ai-task-index">{index + 1}</span>
            <textarea
              className="input nodrag ai-task-input"
              rows={2}
              value={task.description}
              onChange={(e) => updateTask(task.id, e.target.value)}
              placeholder="Що AI має зробити на цьому кроці"
              aria-label={`Завдання ${index + 1}`}
            />
            <div className="ai-task-actions">
              <button
                type="button"
                className="btn-icon-ghost nodrag"
                onClick={() => moveTask(index, -1)}
                disabled={index === 0}
                aria-label="Вгору"
                title="Вгору"
              >
                <IconChevronUp size={13} />
              </button>
              <button
                type="button"
                className="btn-icon-ghost nodrag"
                onClick={() => moveTask(index, 1)}
                disabled={index === tasks.length - 1}
                aria-label="Вниз"
                title="Вниз"
              >
                <IconChevronDown size={13} />
              </button>
              <button
                type="button"
                className="btn-icon-ghost nodrag"
                onClick={() => removeTask(task.id)}
                aria-label="Видалити завдання"
                title="Видалити"
              >
                <IconTrash size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost nodrag" onClick={addTask} style={{ alignSelf: 'flex-start' }}>
        <IconPlus size={14} />
        Додати завдання
      </button>

      <p className="flow-node-hint">
        {tasks.length === 0
          ? 'Без завдань AI говорить, доки дія «Відкрити чат» не передасть тред людині.'
          : 'Коли всі завдання виконані, AI сам передає ліда далі по виходу «Завдання виконані».'}
      </p>

      {/* Three named outputs. Each handle id is stored as
          funnel_edges.from_button_id and resolved by ai-respond.ts — the ids
          must stay in sync with EXIT_* there. */}
      <div className="ai-node-outputs">
        {AI_EXITS.map((exit) => (
          <div className={`ai-node-output ai-node-output-${exit.tone}`} key={exit.id}>
            <span>{exit.label}</span>
            <Handle type="source" position={Position.Right} id={exit.id} className="flow-node-button-handle" />
          </div>
        ))}
      </div>
    </div>
  )
}

const NEW_OPTION = '__new__'

function TagPicker({
  value,
  onChange,
  tags,
  createTag,
}: {
  value: string
  onChange: (tagId: string) => void
  tags: TagOption[]
  createTag?: (name: string) => Promise<CreateResult<TagOption>>
}) {
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    if (!createTag || !name.trim()) return
    setCreating(true)
    setError(null)
    const result = await createTag(name.trim())
    setCreating(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onChange(result.item.id)
    setName('')
    setShowNew(false)
  }

  return (
    <div className="nodrag" style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <select
        className="input nodrag"
        value={value}
        onChange={(e) => {
          if (e.target.value === NEW_OPTION) setShowNew(true)
          else onChange(e.target.value)
        }}
      >
        <option value="">Оберіть тег</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        <option value={NEW_OPTION}>+ Створити новий тег</option>
      </select>

      {showNew && (
        <div style={{ display: 'flex', gap: '0.375rem' }}>
          <input
            className="input nodrag"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Назва тегу"
            autoFocus
          />
          <button type="button" className="btn btn-primary nodrag" style={{ height: 34, flexShrink: 0 }} disabled={creating || !name.trim()} onClick={handleCreate}>
            {creating ? <IconSpinner size={13} /> : 'Додати'}
          </button>
        </div>
      )}
      {error && <span className="flow-node-hint" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  )
}

// Same shape as TagPicker, including the inline "create a new one" miniform —
// a conversion node is usually the first place someone realises they need a
// stage that doesn't exist yet.
function StagePicker({
  value,
  onChange,
  stages,
  createStage,
  updateStageConversion,
}: {
  value: string
  onChange: (stageId: string) => void
  stages: StageOption[]
  createStage?: (name: string, conversion: StageConversionConfig) => Promise<CreateResult<StageOption>>
  updateStageConversion?: (id: string, conversion: StageConversionConfig) => Promise<CreateResult<StageOption>>
}) {
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [track, setTrack] = useState(false)
  const [eventName, setEventName] = useState('')
  const [savingConfig, setSavingConfig] = useState(false)

  const selected = stages.find((st) => st.id === value)
  // Every stage is configurable, including the built-ins — the endpoint stores
  // a built-in's setting per-org so it never leaks into another org.
  const editable = Boolean(selected)

  // Follows the selection rather than local edits, so switching stages shows
  // that stage's own settings instead of the previous one's.
  useEffect(() => {
    setTrack(selected?.track_as_conversion ?? false)
    setEventName(selected?.meta_event_name ?? '')
  }, [selected?.id, selected?.track_as_conversion, selected?.meta_event_name])

  function resetNewForm() {
    setName('')
    setShowNew(false)
  }

  async function handleCreate() {
    if (!createStage || !name.trim()) return
    setCreating(true)
    setError(null)
    const result = await createStage(name.trim(), { trackAsConversion: track, metaEventName: eventName.trim() })
    setCreating(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onChange(result.item.id)
    resetNewForm()
  }

  async function handleSaveConfig() {
    if (!updateStageConversion || !value) return
    setSavingConfig(true)
    setError(null)
    const result = await updateStageConversion(value, { trackAsConversion: track, metaEventName: eventName.trim() })
    setSavingConfig(false)
    if (!result.ok) setError(result.error)
  }

  return (
    <div className="nodrag" style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <select
        className="input nodrag"
        value={value}
        onChange={(e) => {
          if (e.target.value === NEW_OPTION) setShowNew(true)
          else onChange(e.target.value)
        }}
      >
        <option value="">Оберіть етап</option>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value={NEW_OPTION}>+ Створити новий етап</option>
      </select>

      {showNew && (
        <div style={{ display: 'flex', gap: '0.375rem' }}>
          <input
            className="input nodrag"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Назва етапу"
            autoFocus
          />
          <button
            type="button"
            className="btn btn-primary nodrag"
            style={{ height: 34, flexShrink: 0 }}
            disabled={creating || !name.trim()}
            onClick={handleCreate}
          >
            {creating ? <IconSpinner size={13} /> : 'Додати'}
          </button>
        </div>
      )}

      {(showNew || editable) && (
        <div className="stage-capi-config nodrag">
          <label className="stage-capi-toggle">
            <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
            <span>Відправляти конверсію в Meta</span>
          </label>
          {track && (
            <input
              className="input nodrag"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              placeholder="Назва події (Lead, Purchase, Schedule…)"
            />
          )}
          {!showNew && editable && (
            <button
              type="button"
              className="btn btn-secondary nodrag"
              style={{ height: 30 }}
              disabled={savingConfig || (track && !eventName.trim())}
              onClick={handleSaveConfig}
            >
              {savingConfig ? <IconSpinner size={13} /> : 'Зберегти налаштування етапу'}
            </button>
          )}
          <span className="flow-node-hint">
            Подія летить у Meta щоразу, коли лід заходить на цей етап — і з вузла, і при ручній зміні в профілі.
          </span>
        </div>
      )}

      {error && (
        <span className="flow-node-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </div>
  )
}

function VariableDefPicker({
  value,
  onChange,
  variableDefs,
  createVariableDef,
}: {
  value: string
  onChange: (variableDefId: string) => void
  variableDefs: VariableDefOption[]
  createVariableDef?: (key: string, label: string) => Promise<CreateResult<VariableDefOption>>
}) {
  const [showNew, setShowNew] = useState(false)
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    if (!createVariableDef || !key.trim() || !label.trim()) return
    setCreating(true)
    setError(null)
    const result = await createVariableDef(key.trim(), label.trim())
    setCreating(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onChange(result.item.id)
    setKey('')
    setLabel('')
    setShowNew(false)
  }

  return (
    <div className="nodrag" style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <select
        className="input nodrag"
        value={value}
        onChange={(e) => {
          if (e.target.value === NEW_OPTION) setShowNew(true)
          else onChange(e.target.value)
        }}
      >
        <option value="">Оберіть змінну</option>
        {variableDefs.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
        <option value={NEW_OPTION}>+ Створити нову змінну</option>
      </select>

      {showNew && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          <input className="input nodrag" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Ключ (напр. utm_source)" autoFocus />
          <div style={{ display: 'flex', gap: '0.375rem' }}>
            <input className="input nodrag" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Назва" />
            <button
              type="button"
              className="btn btn-primary nodrag"
              style={{ height: 34, flexShrink: 0 }}
              disabled={creating || !key.trim() || !label.trim()}
              onClick={handleCreate}
            >
              {creating ? <IconSpinner size={13} /> : 'Додати'}
            </button>
          </div>
        </div>
      )}
      {error && <span className="flow-node-hint" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  )
}

// Two-click deletion: the first click selects the edge, which reveals an ×
// at its midpoint; the second click removes it. Keyboard Delete/Backspace
// still works on the selected edge — this just doesn't require knowing that.
function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const { setEdges } = useReactFlow()
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            // nodrag/nopan stop the canvas from panning when the button is hit.
            className="edge-delete-btn nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(event) => {
              event.stopPropagation()
              setEdges((eds) => eds.filter((e) => e.id !== id))
            }}
            aria-label="Видалити зв'язок"
            title="Видалити зв'язок"
          >
            <IconClose size={11} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

// Overrides the built-in 'default' edge, so every existing edge gets the
// delete affordance without needing a type stored on it.
const EDGE_TYPES: EdgeTypes = { default: DeletableEdge }

// Shared by the initial fit and the Controls fit-view button so both frame the
// whole graph the same way. minZoom matches the canvas so huge graphs can
// actually fit; maxZoom 1 keeps a one-node graph from being blown up.
const FIT_VIEW_OPTIONS = { padding: 0.2, minZoom: 0.05, maxZoom: 1 }

const NODE_TYPES: NodeTypes = {
  entry: EntryNodeView,
  message: MessageNodeView,
  action: ActionNodeView,
  ai: AiNodeView,
  delay: DelayNodeView,
  condition: ConditionNodeView,
  conversion: ConversionNodeView,
}

const PALETTE_ITEMS: { type: NodeKind; label: string; accentClass: string; icon: typeof IconLogIn; tooltip: string }[] = [
  {
    type: 'entry',
    label: 'Точка входу',
    accentClass: 'palette-item-entry',
    icon: IconLogIn,
    tooltip: 'Початок сценарію. Один вузол одразу покриває Telegram, Facebook Messenger і WhatsApp — ad_ref і трекінг конверсій налаштовуються кліком по вузлу.',
  },
  {
    type: 'message',
    label: 'Повідомлення',
    accentClass: 'palette-item-message',
    icon: IconChat,
    tooltip: 'Надсилає лідy текст, за бажанням із кнопками — кожна кнопка веде до свого наступного кроку сценарію.',
  },
  {
    type: 'action',
    label: 'Дія',
    accentClass: 'palette-item-action',
    icon: IconBolt,
    tooltip: 'Виконує службову операцію без показу ліду — присвоїти тег, змінну, підписати/відписати, відкрити чи закрити чат.',
  },
  {
    type: 'delay',
    label: 'Затримка',
    accentClass: 'palette-item-delay',
    icon: IconStopwatch,
    tooltip:
      'Пауза перед наступним кроком: або відносна (через N годин/хвилин), або до найближчого настання конкретного часу в обраному часовому поясі.',
  },
  {
    type: 'condition',
    label: 'Умова',
    accentClass: 'palette-item-condition',
    icon: IconBranch,
    tooltip:
      'Розгалуження: перевіряє теги й змінні ліда і веде його гілкою «Так» або «Ні». Кілька умов комбінуються через І / АБО.',
  },
  {
    type: 'conversion',
    label: 'Логічна конверсія',
    accentClass: 'palette-item-conversion',
    icon: IconTarget,
    tooltip:
      'Позначає, що лід дійшов до певного етапу аналітичної воронки (наприклад «Підписка» чи «Продажа»). Нічого не надсилає ліду — лише фіксує етап і веде далі.',
  },
  {
    type: 'ai',
    label: 'AI',
    accentClass: 'palette-item-ai',
    icon: IconSparkles,
    tooltip:
      'Передає розмову моделі: з цього кроку на кожне повідомлення ліда відповідає AI за вашим системним промптом, доки дія «Відкрити чат» не поверне тред людині.',
  },
]

export default function FunnelBuilder() {
  return (
    <ReactFlowProvider>
      <FunnelBuilderInner />
    </ReactFlowProvider>
  )
}

function FunnelBuilderInner() {
  const { funnelId } = useParams<{ funnelId: string }>()

  const [funnelName, setFunnelName] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const [togglingActive, setTogglingActive] = useState(false)
  // Enter and Escape both unmount the input, which can fire blur straight
  // after — this lets the blur handler know the key press already dealt with it.
  const renameHandled = useRef(false)
  const [funnelNotFound, setFunnelNotFound] = useState(false)

  const [nodes, setNodes, onNodesChange] = useNodesState<NodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [graphLoading, setGraphLoading] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const [tags, setTags] = useState<TagOption[]>([])
  const [variableDefs, setVariableDefs] = useState<VariableDefOption[]>([])
  const [stages, setStages] = useState<StageOption[]>([])

  const { screenToFlowPosition } = useReactFlow()

  // The org's tags/variable_defs catalogs, for the action-node "Тег"/"Змінна"
  // pickers — managed on /dashboard/elements, read here via RLS.
  useEffect(() => {
    let cancelled = false
    supabase
      .from('tags')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        if (!cancelled && data) setTags(data as TagOption[])
      })
    supabase
      .from('variable_defs')
      .select('id, key, label')
      .order('key')
      .then(({ data }) => {
        if (!cancelled && data) setVariableDefs(data as VariableDefOption[])
      })
    // Built-ins (org_id null) and this org's custom stages both come back
    // here — RLS decides which, position orders them between the bookends.
    // Built-ins are shared rows, so their conversion config lives per-org in
    // org_stage_conversion — merged in here so the picker shows one effective
    // setting regardless of where it's stored.
    Promise.all([
      supabase.from('funnel_stages').select('id, name, is_locked, position, track_as_conversion, meta_event_name').order('position'),
      supabase.from('org_stage_conversion').select('stage_id, track_as_conversion, meta_event_name'),
    ]).then(([stagesRes, overridesRes]) => {
      if (cancelled || !stagesRes.data) return
      const overrides = new Map(
        (overridesRes.data ?? []).map((o) => [o.stage_id as string, o as { track_as_conversion: boolean; meta_event_name: string | null }]),
      )
      setStages(
        (stagesRes.data as StageOption[]).map((st) => {
          const override = overrides.get(st.id)
          return override ? { ...st, track_as_conversion: override.track_as_conversion, meta_event_name: override.meta_event_name } : st
        }),
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  const createTag = useCallback(async (name: string): Promise<CreateResult<TagOption>> => {
    const accessToken = await getAccessToken()
    if (!accessToken) return { ok: false, error: 'Сесія недійсна, увійдіть знову' }

    try {
      const res = await fetch('/.netlify/functions/save-tag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data.error ?? 'Не вдалося створити тег' }
      setTags((prev) => [...prev, data.tag as TagOption].sort((a, b) => a.name.localeCompare(b.name)))
      return { ok: true, item: data.tag as TagOption }
    } catch {
      return { ok: false, error: 'Мережева помилка. Спробуйте ще раз' }
    }
  }, [])

  const createVariableDef = useCallback(async (key: string, label: string): Promise<CreateResult<VariableDefOption>> => {
    const accessToken = await getAccessToken()
    if (!accessToken) return { ok: false, error: 'Сесія недійсна, увійдіть знову' }

    try {
      const res = await fetch('/.netlify/functions/save-variable-def', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ key, label }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data.error ?? 'Не вдалося створити змінну' }
      setVariableDefs((prev) => [...prev, data.variableDef as VariableDefOption].sort((a, b) => a.key.localeCompare(b.key)))
      return { ok: true, item: data.variableDef as VariableDefOption }
    } catch {
      return { ok: false, error: 'Мережева помилка. Спробуйте ще раз' }
    }
  }, [])

  const createStage = useCallback(
    async (name: string, conversion: StageConversionConfig): Promise<CreateResult<StageOption>> => {
      const accessToken = await getAccessToken()
      if (!accessToken) return { ok: false, error: 'Сесія недійсна, увійдіть знову' }

      try {
        const res = await fetch('/.netlify/functions/save-funnel-stage', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            name,
            trackAsConversion: conversion.trackAsConversion,
            metaEventName: conversion.metaEventName,
          }),
        })
        const data = await res.json()
        if (!res.ok) return { ok: false, error: data.error ?? 'Не вдалося створити етап' }
        setStages((prev) => [...prev, data.stage as StageOption].sort((a, b) => a.position - b.position))
        return { ok: true, item: data.stage as StageOption }
      } catch {
        return { ok: false, error: 'Мережева помилка. Спробуйте ще раз' }
      }
    },
    [],
  )

  const updateStageConversion = useCallback(
    async (id: string, conversion: StageConversionConfig): Promise<CreateResult<StageOption>> => {
      const accessToken = await getAccessToken()
      if (!accessToken) return { ok: false, error: 'Сесія недійсна, увійдіть знову' }

      try {
        const res = await fetch('/.netlify/functions/save-funnel-stage', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            id,
            trackAsConversion: conversion.trackAsConversion,
            metaEventName: conversion.metaEventName,
          }),
        })
        const data = await res.json()
        if (!res.ok) return { ok: false, error: data.error ?? 'Не вдалося оновити етап' }
        setStages((prev) => prev.map((st) => (st.id === id ? (data.stage as StageOption) : st)))
        return { ok: true, item: data.stage as StageOption }
      } catch {
        return { ok: false, error: 'Мережева помилка. Спробуйте ще раз' }
      }
    },
    [],
  )

  const handleNodeConfigChange = useCallback(
    (id: string, patch: Partial<NodeConfig>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n)))
    },
    [setNodes],
  )

  const handleNodeDelete = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
    },
    [setNodes, setEdges],
  )

  const duplicateRef = useRef<(id: string) => void>(() => {})

  const buildNode = useCallback(
    (id: string, type: NodeKind, config: NodeConfig, position: XYPosition): Node<NodeData> => ({
      id,
      type,
      position,
      data: {
        config,
        onChange: (patch) => handleNodeConfigChange(id, patch),
        onDelete: () => handleNodeDelete(id),
        // Through a ref: buildNode and the duplicate handler would otherwise
        // each need the other in its dependency list.
        onDuplicate: () => duplicateRef.current(id),
      },
    }),
    [handleNodeConfigChange, handleNodeDelete],
  )

  const handleNodeDuplicate = useCallback(
    (id: string) => {
      setNodes((nds) => {
        const source = nds.find((n) => n.id === id)
        if (!source) return nds

        // structuredClone, not a spread: config nests blocks, buttons,
        // attachments and condition rules. A shallow copy would leave both
        // nodes sharing those arrays, so editing one would silently edit the
        // other.
        const config = structuredClone(source.data.config) as NodeConfig
        config.label = nextCopyLabel(source.data.config.label, nds)

        return [
          ...nds,
          buildNode(crypto.randomUUID(), source.type as NodeKind, config, {
            x: source.position.x + DUPLICATE_OFFSET,
            y: source.position.y + DUPLICATE_OFFSET,
          }),
        ]
      })
      // Edges are deliberately not copied: a duplicate starts unconnected and
      // the author wires it where they actually want it.
    },
    [setNodes, buildNode],
  )

  duplicateRef.current = handleNodeDuplicate

  // Clear the inspector selection if its node was deleted (e.g. via the
  // node's own delete button) or a different funnel just loaded.
  useEffect(() => {
    if (selectedNodeId && !nodes.some((n) => n.id === selectedNodeId)) setSelectedNodeId(null)
  }, [nodes, selectedNodeId])

  const onNodeClick = useCallback((_: unknown, node: Node<NodeData>) => {
    setSelectedNodeId(node.id)
  }, [])

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [])

  // Load the funnel named by the route param: its name (for the header) and
  // its existing graph (hydrate canvas on open).
  useEffect(() => {
    if (!funnelId) return
    let cancelled = false
    setGraphLoading(true)
    setError(null)
    setFunnelNotFound(false)

    supabase
      .from('funnels')
      .select('name, is_active')
      .eq('id', funnelId)
      .maybeSingle()
      .then(({ data: funnelRow }) => {
        if (cancelled) return
        if (!funnelRow) {
          setFunnelNotFound(true)
          setGraphLoading(false)
          return
        }
        setFunnelName(funnelRow.name)
        setIsActive(funnelRow.is_active)
      })

    supabase
      .from('funnel_nodes')
      .select('id, type, config, position')
      .eq('funnel_id', funnelId)
      .then(async ({ data: nodeRows, error: nodesError }) => {
        if (cancelled) return
        if (nodesError) {
          setError(nodesError.message)
          setGraphLoading(false)
          return
        }
        const rows = (nodeRows ?? []) as { id: string; type: NodeKind; config: NodeConfig; position: XYPosition }[]
        const ids = rows.map((r) => r.id)

        const { data: edgeRows } =
          ids.length > 0
            ? await supabase.from('funnel_edges').select('id, from_node_id, from_button_id, to_node_id').in('from_node_id', ids)
            : { data: [] }

        if (cancelled) return

        setNodes(rows.map((r) => buildNode(r.id, r.type, r.config ?? {}, r.position ?? { x: 0, y: 0 })))
        setEdges(
          ((edgeRows ?? []) as { id: string; from_node_id: string; from_button_id: string | null; to_node_id: string }[]).map(
            (e) => ({
              id: e.id,
              source: e.from_node_id,
              sourceHandle: e.from_button_id,
              target: e.to_node_id,
            }),
          ),
        )
        setGraphLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnelId])

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => {
        // A handle can only ever point to one place — resolveNextNode on the
        // backend expects at most one edge per (from_node_id, from_button_id).
        const filtered = eds.filter((e) => !(e.source === connection.source && e.sourceHandle === connection.sourceHandle))
        return addEdge({ ...connection, id: crypto.randomUUID() }, filtered)
      })
    },
    [setEdges],
  )

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/funnel-node-type') as NodeKind
      if (!type) return

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      // Numbered per type so two nodes never land with the same default name
      // — entry included now that a funnel can have several (one per
      // lead-gen link; see LeadGenLinkForm.tsx's entry-point picker).
      const nth = nodes.filter((n) => n.type === type).length + 1
      const defaultLabel =
        type === 'entry'
          ? `Точка входу ${nth}`
          : type === 'message'
            ? `Повідомлення ${nth}`
            : type === 'action'
              ? `Дія ${nth}`
              : type === 'delay'
                ? `Затримка ${nth}`
                : type === 'condition'
                  ? `Умова ${nth}`
                  : `AI ${nth}`
      const initialConfig: NodeConfig =
        type === 'message'
          ? {
              channels: {
                telegram: emptyChannelConfig('markdown_v2'),
                whatsapp: emptyChannelConfig('whatsapp'),
                fbm: emptyChannelConfig('none'),
              },
              buttons: [],
            }
          : type === 'ai'
            ? { context: '', rules: '', model: AI_DEFAULT_MODEL }
            : type === 'delay'
              ? { delay_mode: 'relative', delay_hours: 0, delay_minutes: 30, delay_time: '09:00', delay_tz: DELAY_DEFAULT_TZ }
              : type === 'condition'
                ? { combinator: 'and', conditions: [] }
                : {}
      setNodes((nds) => [...nds, buildNode(crypto.randomUUID(), type, { ...initialConfig, label: defaultLabel }, position)])
    },
    [nodes, screenToFlowPosition, setNodes, buildNode],
  )

  // Sends only funnelId + name: save-funnel.ts treats a request with no
  // definition as a rename, leaving the graph and is_active untouched.
  async function commitRename() {
    const next = nameDraft.trim()
    setRenaming(false)
    if (!funnelId || !next || next === funnelName) return

    const previous = funnelName
    setFunnelName(next)
    setSavingName(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setFunnelName(previous)
      setError('Сесія недійсна, увійдіть знову')
      setSavingName(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-funnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ funnelId, name: next }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFunnelName(previous)
        setError(data.error ?? 'Не вдалося перейменувати тунель')
      }
    } catch {
      setFunnelName(previous)
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSavingName(false)
    }
  }

  // No exclusivity rule: toggling this funnel never affects any other.
  async function handleToggleActive() {
    if (!funnelId) return
    setTogglingActive(true)
    setError(null)

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setTogglingActive(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/toggle-funnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ funnelId, isActive: !isActive }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Не вдалося змінити статус тунелю')
        return
      }

      setIsActive(!isActive)
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setTogglingActive(false)
    }
  }

  async function handleSave() {
    if (!funnelId) return
    const { error: validationError, warning: validationWarning } = validateGraph(nodes, edges)
    if (validationError) {
      setError(validationError)
      setWarning(null)
      return
    }

    setSaving(true)
    setError(null)
    // Set before the request, not after — a warning describes the graph
    // being saved, not the save's outcome, so it shouldn't flicker away and
    // back while the request is in flight.
    setWarning(validationWarning)

    const payloadNodes = nodes.map((n) => ({ id: n.id, type: n.type as NodeKind, config: n.data.config, position: n.position }))
    const payloadEdges = edges.map((e) => ({
      id: e.id,
      from_node_id: e.source,
      from_button_id: e.sourceHandle ?? null,
      to_node_id: e.target,
    }))

    const accessToken = await getAccessToken()
    if (!accessToken) {
      setError('Сесія недійсна, увійдіть знову')
      setSaving(false)
      return
    }

    try {
      const res = await fetch('/.netlify/functions/save-funnel-graph', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ funnelId, nodes: payloadNodes, edges: payloadEdges }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не вдалося зберегти граф')
      }
    } catch {
      setError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSaving(false)
    }
  }

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : undefined

  if (funnelNotFound) {
    return (
      <div className="page fade-in">
        <div className="page-header">
          <div>
            <h1 className="page-title">Тунель не знайдено</h1>
          </div>
        </div>
        <div className="empty-state">
          <span className="empty-state-icon">
            <IconPlug size={22} />
          </span>
          <h3>Цей тунель не існує</h3>
          <p>
            Можливо, його видалили. Поверніться до <Link to="/dashboard/funnels">списку тунелів</Link>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ElementsContext.Provider value={{ tags, variableDefs, stages, createTag, createVariableDef, createStage, updateStageConversion }}>
    <div className="funnel-builder-page fade-in">
      <div className="funnel-builder-header">
        <div className="funnel-builder-header-left">
          <Link to="/dashboard/funnels" className="btn btn-ghost">
            <IconArrowLeft size={16} />
            До списку тунелів
          </Link>
          {renaming ? (
            <input
              className="input funnel-title-input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                if (renameHandled.current) {
                  renameHandled.current = false
                  return
                }
                commitRename()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  renameHandled.current = true
                  commitRename()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  renameHandled.current = true
                  setRenaming(false)
                }
              }}
              aria-label="Назва тунелю"
            />
          ) : (
            <button
              type="button"
              className="funnel-title-button"
              disabled={!funnelId}
              onClick={() => {
                setNameDraft(funnelName ?? '')
                setRenaming(true)
              }}
              title="Перейменувати тунель"
            >
              <span className="page-title" style={{ fontSize: '1.125rem' }}>
                {funnelName ?? 'Редактор тунелю'}
              </span>
              <IconEdit size={14} />
            </button>
          )}
          {(graphLoading || savingName) && <IconSpinner size={16} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {error && (
            <div className="alert alert-error" style={{ padding: '0.5rem 0.75rem' }}>
              <IconAlert size={14} />
              <span style={{ fontSize: '0.8125rem' }}>{error}</span>
            </div>
          )}
          {!error && warning && (
            <div className="alert alert-warning" style={{ padding: '0.5rem 0.75rem' }}>
              <IconAlert size={14} />
              <span style={{ fontSize: '0.8125rem' }}>{warning}</span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              className={`toggle ${isActive ? 'on' : ''}`}
              disabled={!funnelId || togglingActive}
              onClick={() => handleToggleActive()}
              aria-pressed={isActive}
              aria-label={isActive ? 'Вимкнути тунель' : 'Активувати тунель'}
              title={isActive ? 'Активний — клікніть, щоб вимкнути' : 'Неактивний — клікніть, щоб активувати'}
            >
              <span className="toggle-knob" />
            </button>
            <span className={`badge ${isActive ? 'badge-success' : 'badge-neutral'}`}>
              {togglingActive ? <IconSpinner size={12} /> : isActive ? 'Активна' : 'Неактивна'}
            </span>
          </div>
          <button type="button" className="btn btn-primary" disabled={saving || !funnelId} onClick={handleSave}>
            {saving ? <IconSpinner size={16} /> : 'Зберегти'}
          </button>
        </div>
      </div>

      <div className="funnel-builder-body">
        {selectedNode && selectedNode.type === 'entry' && (
          <aside className="funnel-builder-side">
            <div>
              <h3>Точка входу</h3>
              <p className="flow-node-hint">
                Один вузол одразу покриває Telegram, Facebook Messenger і WhatsApp. Посилання, що ведуть у цей тунель,
                створюються окремо на сторінці «Інструменти лідогенерації».
              </p>

              <div className="node-inspector-toggle-row">
                <div>
                  <span className="node-inspector-label" style={{ marginBottom: 0 }}>
                    Відстежувати як конверсію в Meta
                  </span>
                  <p className="flow-node-hint">CAPI-позначку буде збережено; сам виклик Conversions API — окремий крок.</p>
                </div>
                <button
                  type="button"
                  className={`toggle ${selectedNode.data.config.track_as_conversion ? 'on' : ''}`}
                  onClick={() =>
                    handleNodeConfigChange(selectedNode.id, { track_as_conversion: !selectedNode.data.config.track_as_conversion })
                  }
                  aria-pressed={!!selectedNode.data.config.track_as_conversion}
                  aria-label="Відстежувати як конверсію в Meta"
                >
                  <span className="toggle-knob" />
                </button>
              </div>

              <div className="node-inspector-toggle-row">
                <div>
                  <span className="node-inspector-label" style={{ marginBottom: 0 }}>
                    Перезапускати воронку при повторному переході
                  </span>
                  <p className="flow-node-hint">
                    Вимкніть, щоб повторний /start ігнорувався, поки лід у живій розмові з AI-вузлом — стан і прогрес
                    діалогу лишаться незмінними. Для решти статусів (звичайний вузол, завершено, зупинено) перезапуск
                    працює як завжди.
                  </p>
                </div>
                <button
                  type="button"
                  className={`toggle ${selectedNode.data.config.restart_on_reentry !== false ? 'on' : ''}`}
                  onClick={() =>
                    handleNodeConfigChange(selectedNode.id, {
                      restart_on_reentry: selectedNode.data.config.restart_on_reentry === false ? true : false,
                    })
                  }
                  aria-pressed={selectedNode.data.config.restart_on_reentry !== false}
                  aria-label="Перезапускати воронку при повторному переході"
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            </div>
          </aside>
        )}

        <div className="funnel-builder-main">
          <div className="node-palette">
            {PALETTE_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <div
                  key={item.type}
                  className={`palette-item ${item.accentClass}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/funnel-node-type', item.type)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                >
                  <span className="palette-item-icon">
                    <Icon size={17} />
                  </span>
                  <span className="palette-item-label">{item.label}</span>
                  <span className="palette-item-tooltip" role="tooltip">
                    {item.tooltip}
                  </span>
                </div>
              )
            })}
          </div>

          <div className="flow-canvas-wrap" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              // Default is Backspace only; Delete is what most people reach
              // for. React Flow ignores both while focus is in a field, so
              // typing inside a node can't remove a selected edge.
              deleteKeyCode={['Delete', 'Backspace']}
              edgesFocusable
              elementsSelectable
              // React Flow's defaults are 0.5–2, which can't zoom out far
              // enough to show a large graph in one screen.
              minZoom={0.05}
              maxZoom={2.5}
              fitView
              fitViewOptions={FIT_VIEW_OPTIONS}
            >
              <Background />
              <Controls fitViewOptions={FIT_VIEW_OPTIONS} />
              <MiniMap pannable zoomable style={{ backgroundColor: 'var(--surface)' }} maskColor="rgba(9, 9, 11, 0.6)" />
            </ReactFlow>
          </div>
        </div>
      </div>
    </div>
    </ElementsContext.Provider>
  )
}
