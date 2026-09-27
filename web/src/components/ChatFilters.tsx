import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { EMPTY_CHAT_FILTERS, activeFilterCount, type ChatFilterState, type TriState } from '../lib/chatFilters'
import { IconClose, IconFilter, IconPlus, IconSearch } from './icons'

interface Option {
  id: string
  name: string
}

interface FilterOptions {
  tags: Option[]
  vars: Option[]
  funnels: Option[]
  links: Option[]
  landings: Option[]
  stages: Option[]
}

const EMPTY_OPTIONS: FilterOptions = { tags: [], vars: [], funnels: [], links: [], landings: [], stages: [] }

// Everything the panel offers comes from what the org actually has — tags,
// custom variables (variable_defs), funnels, lead-gen links, landings and
// sales stages — all RLS-scoped to the caller's org.
function useFilterOptions() {
  const [options, setOptions] = useState<FilterOptions>(EMPTY_OPTIONS)
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      supabase.from('tags').select('id, name').order('name'),
      supabase.from('variable_defs').select('id, key, label').order('label'),
      supabase.from('funnels').select('id, name').order('name'),
      supabase.from('lead_gen_links').select('id, name').order('name'),
      supabase.from('landing_pages').select('id, name').order('name'),
      supabase.from('funnel_stages').select('id, name, position').order('position'),
    ]).then(([tags, vars, funnels, links, landings, stages]) => {
      if (cancelled) return
      setOptions({
        tags: (tags.data ?? []) as Option[],
        vars: ((vars.data ?? []) as { id: string; key: string; label: string | null }[]).map((v) => ({ id: v.id, name: v.label || v.key })),
        funnels: (funnels.data ?? []) as Option[],
        links: (links.data ?? []) as Option[],
        landings: (landings.data ?? []) as Option[],
        stages: (stages.data ?? []) as Option[],
      })
    })
    return () => {
      cancelled = true
    }
  }, [])
  return options
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

function nameOf(list: Option[], id: string): string {
  return list.find((o) => o.id === id)?.name ?? '…'
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })
}

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="cf-section">
      <div className="cf-section-head">
        <span>{title}</span>
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  )
}

function ChipPicker({ options, selected, onToggle, empty }: { options: Option[]; selected: string[]; onToggle: (id: string) => void; empty: string }) {
  if (options.length === 0) return <p className="cf-empty">{empty}</p>
  return (
    <div className="cf-chips">
      {options.map((o) => (
        <button key={o.id} type="button" className={`cf-chip${selected.includes(o.id) ? ' is-on' : ''}`} onClick={() => onToggle(o.id)} aria-pressed={selected.includes(o.id)}>
          {o.name}
        </button>
      ))}
    </div>
  )
}

function TriSeg({ value, onChange, yes, no }: { value: TriState; onChange: (v: TriState) => void; yes: string; no: string }) {
  return (
    <div className="cf-seg" role="group">
      {(
        [
          ['any', 'Усі'],
          ['yes', yes],
          ['no', no],
        ] as const
      ).map(([v, label]) => (
        <button key={v} type="button" className={value === v ? 'is-on' : ''} onClick={() => onChange(v)} aria-pressed={value === v}>
          {label}
        </button>
      ))}
    </div>
  )
}

interface ChatFilterBarProps {
  value: ChatFilterState
  onChange: (next: ChatFilterState) => void
  /** Shown under the chips while a filtered list is loading. */
  busy?: boolean
}

/**
 * Search box + «Фільтр» button (with the active-filter count) + the panel,
 * and the active filters as removable chips. Changes apply as they're made;
 * Chats.tsx turns the state into a chat_filter_threads call.
 */
export function ChatFilterBar({ value, onChange, busy }: ChatFilterBarProps) {
  const options = useFilterOptions()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value.q)
  const [varDef, setVarDef] = useState('')
  const [varValue, setVarValue] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  // Typing is debounced into the shared state; a reset from outside (the
  // chip ×, «Скинути все») flows back into the box.
  useEffect(() => {
    if (query === value.q) return
    const t = window.setTimeout(() => onChange({ ...value, q: query }), 300)
    return () => window.clearTimeout(t)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setQuery(value.q)
  }, [value.q])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const set = (patch: Partial<ChatFilterState>) => onChange({ ...value, ...patch })
  const count = activeFilterCount(value)

  function addVar() {
    if (!varDef) return
    set({ vars: [...value.vars.filter((v) => v.def !== varDef), { def: varDef, value: varValue.trim() }] })
    setVarDef('')
    setVarValue('')
  }

  // One chip per applied value, each with its own ×.
  const chips: { key: string; label: string; remove: () => void }[] = []
  if (value.from || value.to)
    chips.push({
      key: 'date',
      label: `Активність: ${value.from ? formatDay(value.from) : '…'} – ${value.to ? formatDay(value.to) : '…'}`,
      remove: () => set({ from: '', to: '' }),
    })
  value.tagIds.forEach((id) => chips.push({ key: `t${id}`, label: `#${nameOf(options.tags, id)}`, remove: () => set({ tagIds: value.tagIds.filter((x) => x !== id) }) }))
  value.vars.forEach((v) =>
    chips.push({
      key: `v${v.def}`,
      label: `${nameOf(options.vars, v.def)}${v.value ? ` ∋ «${v.value}»` : ': заповнено'}`,
      remove: () => set({ vars: value.vars.filter((x) => x.def !== v.def) }),
    }),
  )
  if (value.active !== 'any') chips.push({ key: 'active', label: value.active === 'yes' ? 'Активні' : 'Неактивні', remove: () => set({ active: 'any' }) })
  if (value.ai !== 'any') chips.push({ key: 'ai', label: value.ai === 'yes' ? 'AI увімкнено' : 'AI вимкнено', remove: () => set({ ai: 'any' }) })
  value.funnelIds.forEach((id) =>
    chips.push({ key: `f${id}`, label: `Воронка: ${nameOf(options.funnels, id)}`, remove: () => set({ funnelIds: value.funnelIds.filter((x) => x !== id) }) }),
  )
  value.linkIds.forEach((id) =>
    chips.push({ key: `l${id}`, label: `Джерело: ${nameOf(options.links, id)}`, remove: () => set({ linkIds: value.linkIds.filter((x) => x !== id) }) }),
  )
  value.landingIds.forEach((id) =>
    chips.push({ key: `p${id}`, label: `Лендінг: ${nameOf(options.landings, id)}`, remove: () => set({ landingIds: value.landingIds.filter((x) => x !== id) }) }),
  )
  if (value.paid !== 'any') chips.push({ key: 'paid', label: value.paid === 'yes' ? 'Оплатили' : 'Без оплати', remove: () => set({ paid: 'any' }) })
  value.stageIds.forEach((id) =>
    chips.push({ key: `s${id}`, label: `Етап: ${nameOf(options.stages, id)}`, remove: () => set({ stageIds: value.stageIds.filter((x) => x !== id) }) }),
  )

  return (
    <div className="cf" ref={wrapRef}>
      <div className="cf-bar">
        <label className="cf-search">
          <IconSearch size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Пошук: ім'я, @нік, текст"
            aria-label="Пошук по чатах"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
          {query && (
            <button type="button" className="cf-search-clear" onClick={() => setQuery('')} aria-label="Очистити пошук">
              <IconClose size={12} />
            </button>
          )}
        </label>
        <button type="button" className={`cf-btn${open ? ' is-open' : ''}${count > 0 ? ' has-count' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <IconFilter size={14} />
          Фільтр
          {count > 0 && <span className="cf-count">{count}</span>}
        </button>
      </div>

      {chips.length > 0 && (
        <div className="cf-active">
          {chips.map((c) => (
            <span key={c.key} className="cf-active-chip">
              <span>{c.label}</span>
              <button type="button" onClick={c.remove} aria-label={`Зняти фільтр ${c.label}`}>
                <IconClose size={10} />
              </button>
            </span>
          ))}
          <button type="button" className="cf-clear-all" onClick={() => onChange({ ...EMPTY_CHAT_FILTERS, q: value.q })}>
            Скинути все
          </button>
          {busy && <span className="cf-busy" aria-hidden="true" />}
        </div>
      )}

      {open && (
        <div className="cf-panel" role="dialog" aria-label="Фільтри чатів">
          <div className="cf-panel-head">
            <b>Фільтри</b>
            <span>усі умови разом (і), усередині поля — будь-яке зі значень</span>
          </div>
          <div className="cf-panel-body">
            <Section title="Дата останньої активності">
              <div className="cf-dates">
                <input type="date" className="input" value={value.from} max={value.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label="Від" />
                <span>—</span>
                <input type="date" className="input" value={value.to} min={value.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label="До" />
              </div>
            </Section>

            <div className="cf-grid3">
              <Section title="Статус ліда">
                <TriSeg value={value.active} onChange={(v) => set({ active: v })} yes="Активні" no="Неактивні" />
              </Section>
              <Section title="AI">
                <TriSeg value={value.ai} onChange={(v) => set({ ai: v })} yes="Увімк." no="Вимк." />
              </Section>
              <Section title="Оплата">
                <TriSeg value={value.paid} onChange={(v) => set({ paid: v })} yes="Так" no="Ні" />
              </Section>
            </div>

            <Section title="Етап продажу">
              <ChipPicker options={options.stages} selected={value.stageIds} onToggle={(id) => set({ stageIds: toggle(value.stageIds, id) })} empty="Етапів ще немає" />
            </Section>

            <Section title="Воронка">
              <ChipPicker options={options.funnels} selected={value.funnelIds} onToggle={(id) => set({ funnelIds: toggle(value.funnelIds, id) })} empty="Воронок ще немає" />
            </Section>

            <Section title="Джерело">
              {options.landings.length > 0 && (
                <div className="cf-sub">
                  <small>Лендінги</small>
                  <ChipPicker options={options.landings} selected={value.landingIds} onToggle={(id) => set({ landingIds: toggle(value.landingIds, id) })} empty="" />
                </div>
              )}
              <div className="cf-sub">
                <small>Лід-ген посилання</small>
                <ChipPicker options={options.links} selected={value.linkIds} onToggle={(id) => set({ linkIds: toggle(value.linkIds, id) })} empty="Посилань ще немає" />
              </div>
            </Section>

            <Section title="Теги">
              <ChipPicker options={options.tags.map((t) => ({ ...t, name: `#${t.name}` }))} selected={value.tagIds} onToggle={(id) => set({ tagIds: toggle(value.tagIds, id) })} empty="Тегів ще немає" />
            </Section>

            <Section title="Змінні ліда" hint="значення містить текст; порожнє — просто заповнена">
              {options.vars.length === 0 ? (
                <p className="cf-empty">Змінних ще немає — вони з'являються, коли воронка зберігає відповіді ліда.</p>
              ) : (
                <div className="cf-var-row">
                  <select className="input" value={varDef} onChange={(e) => setVarDef(e.target.value)} aria-label="Змінна">
                    <option value="">Оберіть змінну…</option>
                    {options.vars.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    value={varValue}
                    onChange={(e) => setVarValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addVar()
                    }}
                    placeholder="значення (необов'язково)"
                    aria-label="Значення змінної"
                  />
                  <button type="button" className="cf-add" onClick={addVar} disabled={!varDef} aria-label="Додати умову">
                    <IconPlus size={14} />
                  </button>
                </div>
              )}
            </Section>
          </div>
          <div className="cf-panel-foot">
            <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...EMPTY_CHAT_FILTERS, q: value.q })} disabled={count === 0}>
              Скинути все
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
              Готово
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
