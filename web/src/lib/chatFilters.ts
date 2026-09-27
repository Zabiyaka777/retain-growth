// State of the /chats search + filter panel, and how it maps onto the
// chat_filter_threads RPC. Kept out of the component file so both it and
// Chats.tsx can share it.

export type TriState = 'any' | 'yes' | 'no'

export interface ChatFilterState {
  q: string
  from: string
  to: string
  tagIds: string[]
  /** Custom lead variables: def = variable_defs.id; empty value = "is set". */
  vars: { def: string; value: string }[]
  active: TriState
  ai: TriState
  funnelIds: string[]
  linkIds: string[]
  landingIds: string[]
  paid: TriState
  stageIds: string[]
}

export const EMPTY_CHAT_FILTERS: ChatFilterState = {
  q: '',
  from: '',
  to: '',
  tagIds: [],
  vars: [],
  active: 'any',
  ai: 'any',
  funnelIds: [],
  linkIds: [],
  landingIds: [],
  paid: 'any',
  stageIds: [],
}

/** Filters counted on the «Фільтр» button — the search box isn't one of them. */
export function activeFilterCount(f: ChatFilterState): number {
  return (
    (f.from || f.to ? 1 : 0) +
    (f.tagIds.length ? 1 : 0) +
    f.vars.length +
    (f.active !== 'any' ? 1 : 0) +
    (f.ai !== 'any' ? 1 : 0) +
    (f.funnelIds.length ? 1 : 0) +
    (f.linkIds.length || f.landingIds.length ? 1 : 0) +
    (f.paid !== 'any' ? 1 : 0) +
    (f.stageIds.length ? 1 : 0)
  )
}

export function isFiltering(f: ChatFilterState): boolean {
  return f.q.trim() !== '' || activeFilterCount(f) > 0
}

const tri = (v: TriState) => (v === 'any' ? null : v === 'yes')
const list = (v: string[]) => (v.length ? v : null)

export function toRpcArgs(f: ChatFilterState) {
  return {
    p_q: f.q.trim() || null,
    p_from: f.from || null,
    p_to: f.to || null,
    p_tag_ids: list(f.tagIds),
    p_vars: f.vars.length ? f.vars : null,
    p_active: tri(f.active),
    p_ai: tri(f.ai),
    p_funnel_ids: list(f.funnelIds),
    p_link_ids: list(f.linkIds),
    p_landing_ids: list(f.landingIds),
    p_paid: tri(f.paid),
    p_stage_ids: list(f.stageIds),
  }
}
