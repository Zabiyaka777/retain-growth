import { useMemo, useState } from 'react'
import { resolvePeriod, type Period, type PeriodPreset } from './analyticsFinance'

// Shared by the Аналітика page and the landing analytics popup.

export interface PeriodState {
  preset: PeriodPreset
  setPreset: (p: PeriodPreset) => void
  customFrom: string
  setCustomFrom: (v: string) => void
  customTo: string
  setCustomTo: (v: string) => void
  period: Period
}

export function usePeriod(initial: PeriodPreset = 30): PeriodState {
  const [preset, setPreset] = useState<PeriodPreset>(initial)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const period = useMemo(() => resolvePeriod(preset, customFrom, customTo), [preset, customFrom, customTo])
  return { preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, period }
}

export function formatPeriodDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('uk-UA')
}

export function formatMoney(value: number): string {
  return value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatPercent(value: number | null, digits = 1): string {
  if (value === null) return '—'
  return `${value.toLocaleString('uk-UA', { maximumFractionDigits: value >= 10 ? 0 : digits })}%`
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} с`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m} хв ${String(s).padStart(2, '0')} с` : `${m} хв`
}
