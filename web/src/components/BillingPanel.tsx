import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { supabase } from '../lib/supabaseClient'
import { calcSubscriptionPrice } from '../lib/subscriptionPricing'
import { IconAlert, IconCreditCard, IconSpinner, IconUsers } from './icons'

interface SeatAddon {
  id: string
  key: 'extra_seat'
  name: string
  price_monthly: number
}

interface OrgDiscount {
  id: string
  label: string
  percent: number
  expires_at: string | null
}

interface OrgBillingState {
  trial_started_at: string
  trial_ends_at: string
  plan_status: 'trial' | 'free' | 'active'
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const SEAT_MAX = 20
const TRIAL_DAYS = 21

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

async function callToggleAddon(body: { addonKey: string; enabled: boolean; quantity?: number }) {
  const token = await getAccessToken()
  if (!token) throw new Error('Не авторизовано')

  const res = await fetch('/.netlify/functions/toggle-billing-addon', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    throw new Error(payload.error || 'Не вдалося оновити кількість менеджерів')
  }
}

function formatMoney(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

// Tweens the displayed number toward `target` instead of snapping — the
// "Поточний рахунок" total should visibly count up/down on every change.
// Presentational only: the real, authoritative value is always `target`
// itself (computed below from unchanged billing state), this hook only
// smooths what's shown on screen a moment before it catches up.
function useAnimatedNumber(target: number, duration = 500): number {
  const [display, setDisplay] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) {
      fromRef.current = target
      setDisplay(target)
      return
    }

    const from = fromRef.current
    if (from === target) return
    const start = performance.now()

    function tick(now: number) {
      const elapsed = now - start
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(from + (target - from) * eased)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [target, duration])

  return display
}

export default function BillingPanel() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [billingState, setBillingState] = useState<OrgBillingState | null>(null)
  const [seatAddon, setSeatAddon] = useState<SeatAddon | null>(null)
  const [seatQuantity, setSeatQuantity] = useState(0)
  const [subscriberCount, setSubscriberCount] = useState(0)
  const [discounts, setDiscounts] = useState<OrgDiscount[]>([])
  const [busy, setBusy] = useState(false)

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [stateRes, addonRes, orgAddonsRes, subsRes, discountsRes] = await Promise.all([
      supabase.from('org_billing_state').select('trial_started_at, trial_ends_at, plan_status').maybeSingle(),
      supabase.from('billing_addons').select('id, key, name, price_monthly').eq('key', 'extra_seat').maybeSingle(),
      supabase.from('org_billing_addons').select('addon_id, quantity, billing_addons ( key )'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('subscribed', true),
      supabase.from('org_discounts').select('id, label, percent, expires_at'),
    ])

    if (stateRes.error || addonRes.error || orgAddonsRes.error || subsRes.error || discountsRes.error) {
      setError(
        stateRes.error?.message ||
          addonRes.error?.message ||
          orgAddonsRes.error?.message ||
          subsRes.error?.message ||
          discountsRes.error?.message ||
          'Не вдалося завантажити дані тарифікації',
      )
      setLoading(false)
      return
    }

    setBillingState(stateRes.data as OrgBillingState | null)
    setSeatAddon((addonRes.data as SeatAddon | null) ?? null)

    const seatRow = ((orgAddonsRes.data ?? []) as unknown as { quantity: number; billing_addons: { key: string } | null }[]).find(
      (row) => row.billing_addons?.key === 'extra_seat',
    )
    setSeatQuantity(seatRow?.quantity ?? 0)
    setSubscriberCount(subsRes.count ?? 0)
    setDiscounts((discountsRes.data ?? []) as OrgDiscount[])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function setSeats(nextQuantity: number) {
    const clamped = Math.max(0, Math.min(SEAT_MAX, nextQuantity))
    setBusy(true)
    setError(null)
    try {
      if (clamped === 0) {
        await callToggleAddon({ addonKey: 'extra_seat', enabled: false })
      } else {
        await callToggleAddon({ addonKey: 'extra_seat', enabled: true, quantity: clamped })
      }
      setSeatQuantity(clamped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося оновити кількість менеджерів')
    } finally {
      setBusy(false)
    }
  }

  const grossBill = calcSubscriptionPrice(subscriberCount, seatQuantity)

  // Modifier layered on top of the formula above, not a change to it: an
  // expired discount (expires_at in the past) never applies. Several active
  // discounts stack by adding their percentages, capped at 100 so the total
  // can't go negative.
  const activeDiscounts = discounts.filter((d) => !d.expires_at || new Date(d.expires_at).getTime() > Date.now())
  const discountPct = Math.min(100, activeDiscounts.reduce((sum, d) => sum + d.percent, 0))
  const discountAmount = grossBill * (discountPct / 100)
  const finalBill = Math.max(0, grossBill - discountAmount)

  const animatedBill = useAnimatedNumber(finalBill)

  const daysLeft =
    billingState?.plan_status === 'trial'
      ? Math.max(0, Math.ceil((new Date(billingState.trial_ends_at).getTime() - Date.now()) / MS_PER_DAY))
      : null

  // Presentational blend, calm green -> warm red, purely for the trial
  // banner's icon/progress-bar tint. Doesn't feed into daysLeft itself.
  const trialColorPct = daysLeft === null ? 100 : Math.max(0, Math.min(100, Math.round((daysLeft / TRIAL_DAYS) * 100)))
  // oklch, not srgb: mixing this codebase's green and red tokens in srgb
  // produces a muddy tan in the middle of the range — oklch keeps the blend
  // passing through a clean warm amber instead, matching "тепліший", not
  // "brownish", as the trial runs down.
  const trialColor = `color-mix(in oklch, var(--success) ${trialColorPct}%, var(--danger))`

  if (loading) {
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
        <IconSpinner size={20} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 760, paddingBottom: '1rem' }}>
      <div className="card billing-hero" style={billingState?.plan_status === 'trial' ? ({ '--trial-color': trialColor } as CSSProperties) : undefined}>
        <span className="billing-hero-icon">
          <IconCreditCard size={22} />
        </span>
        <div className="billing-hero-body">
          {billingState?.plan_status === 'trial' && (
            <>
              <div className="billing-hero-title">
                Триал: залишилось {daysLeft} {daysLeft === 1 ? 'день' : 'днів'} (повний доступ)
              </div>
              <div className="billing-hero-progress-track">
                <div className="billing-hero-progress-fill" style={{ width: `${Math.round(((TRIAL_DAYS - (daysLeft ?? 0)) / TRIAL_DAYS) * 100)}%` }} />
              </div>
              <div className="billing-hero-progress-caption">
                День {TRIAL_DAYS - (daysLeft ?? 0)} з {TRIAL_DAYS}
              </div>
            </>
          )}
          {billingState?.plan_status === 'free' && <div className="billing-hero-title">Безкоштовний план</div>}
          {billingState?.plan_status === 'active' && <div className="billing-hero-title">Активний план — $29/міс базово, усі можливості без обмежень</div>}
          {!billingState && <div className="billing-hero-title">Стан тарифу недоступний</div>}
        </div>
      </div>

      <div className="card">
        <div className="settings-row-label" style={{ marginBottom: '0.625rem' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <IconUsers size={15} />
            Підписники
          </span>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 600 }}>{subscriberCount.toLocaleString('uk-UA')}</div>
        <div className="settings-row-hint" style={{ marginTop: '0.25rem' }}>
          Перші 2 500 — у базовій ціні. Далі +$5 за кожну наступну тисячу.
        </div>
      </div>

      <div className="card">
        <div className="settings-row-label" style={{ marginBottom: '0.625rem' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <IconUsers size={15} />
            Менеджери
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="billing-stepper">
            <button type="button" className="billing-stepper-btn" onClick={() => setSeats(seatQuantity - 1)} disabled={busy || seatQuantity === 0} aria-label="Зменшити кількість менеджерів">
              −
            </button>
            <span className="billing-stepper-value">{seatQuantity}</span>
            <button type="button" className="billing-stepper-btn" onClick={() => setSeats(seatQuantity + 1)} disabled={busy || seatQuantity >= SEAT_MAX} aria-label="Збільшити кількість менеджерів">
              +
            </button>
          </div>
          <span className="billing-addon-price">
            ${formatMoney(seatAddon?.price_monthly ?? 5)}
            <span className="billing-addon-price-unit">/міс·місце</span>
          </span>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="billing-summary-bar">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
          <span className="billing-summary-label">Поточний рахунок</span>
          {discountPct > 0 && (
            <span className="billing-summary-discount">
              Знижка {discountPct}%: −${formatMoney(discountAmount)}
            </span>
          )}
        </div>
        <span className="billing-summary-value">${formatMoney(animatedBill)}/міс</span>
      </div>
    </div>
  )
}
