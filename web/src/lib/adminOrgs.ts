import { supabase } from './supabaseClient'

// Shared by the admin organizations list and the organization profile.

export type PlanStatus = 'trial' | 'free' | 'active'

export interface OrgBill {
  gross: number
  discountPct: number
  net: number
  subscriberCount: number
  managerSeats: number
}

export interface AdminOrgListItem {
  id: string
  name: string
  created_at: string
  owner_email: string | null
  plan_status: PlanStatus | null
  trial_ends_at: string | null
  addons_count: number
  bill: OrgBill
  members: number
  lead_count: number
  channels: string[]
  last_thread_at: string | null
}

export interface AdminOrgTotals {
  organizations: number
  by_status: { trial: number; free: number; active: number; none: number }
  mrr: number
  trial_pipeline: number
  new_30d: number
  active_30d: number
  leads: number
}

export async function adminOrgsApi<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Сесія недійсна, увійдіть знову')
  const res = await fetch('/.netlify/functions/admin-organizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Не вдалося виконати запит')
  return json as T
}

export const STATUS_META: Record<PlanStatus | 'none', { label: string; code: string; tone: string }> = {
  active: { label: 'Активна', code: 'ACCESS ACTIVE', tone: 'active' },
  trial: { label: 'Тріал', code: 'TRIAL MODE', tone: 'trial' },
  free: { label: 'Free', code: 'LIMITED', tone: 'free' },
  none: { label: 'Без білінгу', code: 'NO BILLING', tone: 'none' },
}

export const CHANNEL_LABELS: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', fbm: 'Messenger' }

export function usd(n: number): string {
  return `$${n.toLocaleString('uk-UA', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}

export function formatDate(iso: string | null, withTime = false): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  })
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'ніколи'
  const diff = Date.now() - Date.parse(iso)
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'щойно'
  if (min < 60) return `${min} хв тому`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} год тому`
  const d = Math.round(h / 24)
  if (d < 31) return `${d} дн тому`
  return formatDate(iso)
}

export function trialDaysLeft(iso: string | null): number | null {
  if (!iso) return null
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000))
}

export function orgInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}
