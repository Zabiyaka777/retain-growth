import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { supabase } from '../lib/supabaseClient'
import {
  IconAlert,
  IconChat,
  IconCreditCard,
  IconFunnel,
  IconMeta,
  IconSparkles,
  IconSpinner,
  IconTrendingUp,
  IconUsers,
} from './icons'

interface BillingAddon {
  id: string
  key: string
  name: string
  price_monthly: number
  description: string | null
}

interface OrgBillingAddonRow {
  addon_id: string
  quantity: number
  billing_addons: BillingAddon | null
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
const FREE_SUBSCRIBER_LIMIT = 500
const PRO_SUBSCRIBER_LIMIT = 2500
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
    throw new Error(payload.error || 'Не вдалося оновити модуль')
  }
}

function formatMoney(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

// Purely presentational — a punchier one-liner per addon than the catalog's
// own `description` (which stays as the plain factual copy shown nowhere
// here, kept in the DB for other/future surfaces).
const ADDON_PITCH: Record<string, string> = {
  whatsapp_fbm: 'Ловіть ліди там, де вони вже пишуть — WhatsApp і Messenger в одному місці',
  ai_agent: 'Ваш AI ніколи не спить — відповідає лідам 24/7, поки ви спите',
  meta_capi: 'Точніша реклама — Meta бачить кожну конверсію, навіть коли cookie заблоковано',
  pro_analytics: 'Бачте більше — розширена аналітика і вищий поріг підписників',
  unlimited_funnels: 'Масштабуйтесь без обмежень — необмежена кількість тунелів і лідоген-інструментів',
  extra_seat: 'Додайте менеджера в команду — більше рук, швидші відповіді лідам',
}

const ADDON_ICON: Record<string, typeof IconChat> = {
  whatsapp_fbm: IconChat,
  ai_agent: IconSparkles,
  meta_capi: IconMeta,
  pro_analytics: IconTrendingUp,
  unlimited_funnels: IconFunnel,
  extra_seat: IconUsers,
}

// Tweens the displayed number toward `target` instead of snapping — the
// "Поточний рахунок" total should visibly count up/down on every toggle.
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
  const [catalog, setCatalog] = useState<BillingAddon[]>([])
  const [enabled, setEnabled] = useState<Map<string, number>>(new Map())
  const [subscriberCount, setSubscriberCount] = useState(0)
  const [discounts, setDiscounts] = useState<OrgDiscount[]>([])
  const [busyKey, setBusyKey] = useState<string | null>(null)
  // Presentational-only: which card just got switched on, so its
  // billing-toggle-pulse animation can play once and clear itself. Never
  // read by any billing calculation.
  const [pulsingKey, setPulsingKey] = useState<string | null>(null)

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [stateRes, catalogRes, orgAddonsRes, subsRes, discountsRes] = await Promise.all([
      supabase.from('org_billing_state').select('trial_started_at, trial_ends_at, plan_status').maybeSingle(),
      supabase.from('billing_addons').select('id, key, name, price_monthly, description').order('price_monthly'),
      supabase.from('org_billing_addons').select('addon_id, quantity, billing_addons ( id, key, name, price_monthly, description )'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('subscribed', true),
      supabase.from('org_discounts').select('id, label, percent, expires_at'),
    ])

    if (stateRes.error || catalogRes.error || orgAddonsRes.error || subsRes.error || discountsRes.error) {
      setError(
        stateRes.error?.message ||
          catalogRes.error?.message ||
          orgAddonsRes.error?.message ||
          subsRes.error?.message ||
          discountsRes.error?.message ||
          'Не вдалося завантажити дані тарифікації',
      )
      setLoading(false)
      return
    }

    setBillingState(stateRes.data as OrgBillingState | null)
    setCatalog((catalogRes.data ?? []) as BillingAddon[])

    const enabledMap = new Map<string, number>()
    for (const row of (orgAddonsRes.data ?? []) as unknown as OrgBillingAddonRow[]) {
      const key = row.billing_addons?.key
      if (key) enabledMap.set(key, row.quantity)
    }
    setEnabled(enabledMap)
    setSubscriberCount(subsRes.count ?? 0)
    setDiscounts((discountsRes.data ?? []) as OrgDiscount[])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function toggleAddon(key: string, nextEnabled: boolean) {
    setBusyKey(key)
    setError(null)
    try {
      await callToggleAddon({ addonKey: key, enabled: nextEnabled })
      setEnabled((prev) => {
        const next = new Map(prev)
        if (nextEnabled) next.set(key, 1)
        else next.delete(key)
        return next
      })
      if (nextEnabled) {
        setPulsingKey(key)
        setTimeout(() => setPulsingKey((current) => (current === key ? null : current)), 1600)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося оновити модуль')
    } finally {
      setBusyKey(null)
    }
  }

  async function setSeatQuantity(nextQuantity: number) {
    const clamped = Math.max(0, Math.min(SEAT_MAX, nextQuantity))
    setBusyKey('extra_seat')
    setError(null)
    try {
      if (clamped === 0) {
        await callToggleAddon({ addonKey: 'extra_seat', enabled: false })
        setEnabled((prev) => {
          const next = new Map(prev)
          next.delete('extra_seat')
          return next
        })
      } else {
        await callToggleAddon({ addonKey: 'extra_seat', enabled: true, quantity: clamped })
        setEnabled((prev) => new Map(prev).set('extra_seat', clamped))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося оновити кількість менеджерів')
    } finally {
      setBusyKey(null)
    }
  }

  const proAnalyticsEnabled = enabled.has('pro_analytics')
  const subscriberThreshold = proAnalyticsEnabled ? PRO_SUBSCRIBER_LIMIT : FREE_SUBSCRIBER_LIMIT
  const subscriberPct = Math.min(100, Math.round((subscriberCount / subscriberThreshold) * 100))

  const currentBill = catalog.reduce((sum, addon) => {
    const qty = enabled.get(addon.key)
    if (!qty) return sum
    return sum + addon.price_monthly * qty
  }, 0)

  // Modifier layered on top of the addon sum above, not a change to it: an
  // expired discount (expires_at in the past) never applies. Several active
  // discounts stack by adding their percentages, capped at 100 so the total
  // can't go negative.
  const activeDiscounts = discounts.filter((d) => !d.expires_at || new Date(d.expires_at).getTime() > Date.now())
  const discountPct = Math.min(100, activeDiscounts.reduce((sum, d) => sum + d.percent, 0))
  const discountAmount = currentBill * (discountPct / 100)
  const finalBill = Math.max(0, currentBill - discountAmount)

  const animatedBill = useAnimatedNumber(finalBill)

  const daysLeft =
    billingState?.plan_status === 'trial'
      ? Math.max(0, Math.ceil((new Date(billingState.trial_ends_at).getTime() - Date.now()) / MS_PER_DAY))
      : null

  const enabledAddonNames = catalog.filter((a) => enabled.has(a.key)).map((a) => a.name)

  const regularAddons = catalog.filter((a) => a.key !== 'extra_seat')
  const seatAddon = catalog.find((a) => a.key === 'extra_seat')
  const seatQuantity = enabled.get('extra_seat') ?? 0

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
          {billingState?.plan_status === 'free' && (
            <div className="billing-hero-title">Безкоштовний план (500 підписників, 1 тунель, 1 ЛГТ, Base аналітика)</div>
          )}
          {billingState?.plan_status === 'active' && (
            <div className="billing-hero-title">
              {enabledAddonNames.length > 0 ? `Підключено: ${enabledAddonNames.join(', ')}` : 'Активний план'}
            </div>
          )}
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 600 }}>
            {subscriberCount.toLocaleString('uk-UA')}
          </span>
          <span className="settings-row-hint">з {subscriberThreshold.toLocaleString('uk-UA')}</span>
        </div>
        <div className="billing-subscriber-track">
          <div className={`billing-subscriber-fill${subscriberPct >= 100 ? ' is-over' : ''}`} style={{ width: `${subscriberPct}%` }} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div className="settings-row-label">Додаткові модулі</div>

        <div className="billing-addon-grid">
          {regularAddons.map((addon, i) => {
            const Icon = ADDON_ICON[addon.key] ?? IconSparkles
            const isActive = enabled.has(addon.key)
            return (
              <div
                key={addon.id}
                className={`billing-addon-card${isActive ? ' is-active' : ''}${pulsingKey === addon.key ? ' is-pulsing' : ''}`}
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div className="billing-addon-top">
                  <span className="billing-addon-icon">
                    <Icon size={19} />
                  </span>
                  <button
                    type="button"
                    className={`toggle ${isActive ? 'on' : ''}`}
                    onClick={() => toggleAddon(addon.key, !isActive)}
                    disabled={busyKey === addon.key}
                    aria-pressed={isActive}
                    aria-label={addon.name}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                <div className="billing-addon-name">{addon.name}</div>
                <div className="billing-addon-copy">{ADDON_PITCH[addon.key] ?? addon.description}</div>
                <div className="billing-addon-footer">
                  <span className="settings-row-hint">Щомісяця</span>
                  <span className="billing-addon-price">
                    ${formatMoney(addon.price_monthly)}
                    <span className="billing-addon-price-unit">/міс</span>
                  </span>
                </div>
              </div>
            )
          })}

          {seatAddon &&
            (() => {
              const SeatIcon = ADDON_ICON.extra_seat
              const isActive = seatQuantity > 0
              return (
                <div
                  className={`billing-addon-card billing-seat-card${isActive ? ' is-active' : ''}`}
                  style={{ animationDelay: `${regularAddons.length * 40}ms` }}
                >
                  <div className="billing-addon-top">
                    <span className="billing-addon-icon">
                      <SeatIcon size={19} />
                    </span>
                  </div>
                  <div className="billing-addon-name">{seatAddon.name}</div>
                  <div className="billing-addon-copy">{ADDON_PITCH.extra_seat ?? seatAddon.description}</div>
                  <div className="billing-addon-footer">
                    <div className="billing-stepper">
                      <button
                        type="button"
                        className="billing-stepper-btn"
                        onClick={() => setSeatQuantity(seatQuantity - 1)}
                        disabled={busyKey === 'extra_seat' || seatQuantity === 0}
                        aria-label="Зменшити кількість менеджерів"
                      >
                        −
                      </button>
                      <span className="billing-stepper-value">{seatQuantity}</span>
                      <button
                        type="button"
                        className="billing-stepper-btn"
                        onClick={() => setSeatQuantity(seatQuantity + 1)}
                        disabled={busyKey === 'extra_seat' || seatQuantity >= SEAT_MAX}
                        aria-label="Збільшити кількість менеджерів"
                      >
                        +
                      </button>
                    </div>
                    <span className="billing-addon-price">
                      ${formatMoney(seatAddon.price_monthly)}
                      <span className="billing-addon-price-unit">/міс·місце</span>
                    </span>
                  </div>
                </div>
              )
            })()}
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
