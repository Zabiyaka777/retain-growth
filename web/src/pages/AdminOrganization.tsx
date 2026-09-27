import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  IconAlert,
  IconArrowLeft,
  IconBolt,
  IconCreditCard,
  IconDuplicate,
  IconHistory,
  IconPlus,
  IconShield,
  IconSpinner,
  IconTrash,
  IconUsers,
  IconWallet,
} from '../components/icons'
import {
  CHANNEL_LABELS,
  STATUS_META,
  adminOrgsApi,
  formatDate,
  orgInitial,
  relativeTime,
  trialDaysLeft,
  usd,
  type OrgBill,
  type PlanStatus,
} from '../lib/adminOrgs'
import { calcSubscriptionPrice } from '../lib/subscriptionPricing'

interface Detail {
  organization: {
    id: string
    name: string
    created_at: string
    base_currency: string
    owner: { id: string; email: string | null }
    members: { id: string; email: string | null; created_at: string; is_owner: boolean }[]
  }
  billing: {
    state: { plan_status: PlanStatus; trial_started_at: string; trial_ends_at: string; created_at: string } | null
    addons: { key: string; name: string; price_monthly: number; quantity: number; enabled_at: string }[]
    catalog: { key: string; name: string; price_monthly: number; description: string | null }[]
    discounts: { id: string; label: string; percent: number; expires_at: string | null; created_at: string }[]
    bill: OrgBill
  }
  usage: {
    leads: number
    subscribers: number
    threads: number
    messages_30d: number
    landings: number
    links: number
    funnels: number
    channels: string[]
    last_thread_at: string | null
  }
  audit: { id: string; action: string; details: Record<string, unknown> | null; created_at: string }[]
  events: { id: string; type: string; level: string; payload: Record<string, unknown> | null; created_at: string }[]
}

type FeedKind = 'admin' | 'system' | 'billing'
interface FeedItem {
  id: string
  at: string
  kind: FeedKind
  tone: 'accent' | 'ai' | 'danger' | 'warning' | 'success' | 'muted'
  title: string
  note?: string
}

const STATUS_WORD: Record<string, string> = { trial: 'Тріал', free: 'Free', active: 'Активна' }

function describeAudit(action: string, d: Record<string, unknown>): { title: string; note?: string; tone: FeedItem['tone'] } {
  const who = typeof d.admin_email === 'string' ? d.admin_email : undefined
  switch (action) {
    case 'organization_detail':
      return { title: 'Адмін відкрив профіль', note: who, tone: 'muted' }
    case 'events_list':
      return { title: 'Адмін переглянув системні події', note: who, tone: 'muted' }
    case 'org_discount_created':
      return { title: `Знижка додана: ${d.label ?? ''} −${d.percent ?? '?'}%`, note: who, tone: 'success' }
    case 'org_discount_deleted':
      return { title: `Знижку видалено: ${d.label ?? ''}`, note: who, tone: 'warning' }
    case 'org_plan_status_set':
      return { title: `Статус плану: ${STATUS_WORD[String(d.from)] ?? 'немає'} → ${STATUS_WORD[String(d.to)] ?? d.to}`, note: who, tone: 'accent' }
    case 'org_trial_end_set':
      return { title: `Тріал до ${formatDate(String(d.to))}`, note: who, tone: 'accent' }
    case 'org_addon_enabled':
      return { title: `Модуль увімкнено: ${d.name ?? d.addon}${Number(d.quantity) > 1 ? ` ×${d.quantity}` : ''}`, note: who, tone: 'success' }
    case 'org_addon_disabled':
      return { title: `Модуль вимкнено: ${d.name ?? d.addon}`, note: who, tone: 'warning' }
    case 'org_addons_removed':
      return { title: `Усі модулі вимкнено (${d.removed ?? 0})`, note: who, tone: 'danger' }
    case 'landing_unpublished':
    case 'landing_review_unpublish':
      return { title: 'Адмін зняв лендінг з публікації', note: who, tone: 'danger' }
    default:
      return { title: action, note: who, tone: 'muted' }
  }
}

function summarizePayload(p: Record<string, unknown> | null): string | undefined {
  if (!p) return undefined
  const text = Object.entries(p)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
    .join(' · ')
  return text || undefined
}

function Section({ icon, title, code, children, className = '' }: { icon: React.ReactNode; title: string; code?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`adm-section ${className}`}>
      <header className="adm-section-head">
        <span className="adm-section-icon" aria-hidden="true">
          {icon}
        </span>
        <h2>{title}</h2>
        {code && <span className="adm-code">{code}</span>}
      </header>
      {children}
    </section>
  )
}

export default function AdminOrganization() {
  const { orgId = '' } = useParams<{ orgId: string }>()
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [feedFilter, setFeedFilter] = useState<'all' | FeedKind>('all')
  const [showViews, setShowViews] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await adminOrgsApi<Detail>({ action: 'detail', orgId })
      setData(d)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  async function run(key: string, body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(key)
    setActionError(null)
    try {
      await adminOrgsApi({ ...body, orgId })
      await load()
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const feed = useMemo<FeedItem[]>(() => {
    if (!data) return []
    const items: FeedItem[] = []
    for (const a of data.audit) {
      if (!showViews && (a.action === 'organization_detail' || a.action === 'events_list')) continue
      const d = describeAudit(a.action, a.details ?? {})
      items.push({ id: `a${a.id}`, at: a.created_at, kind: 'admin', ...d })
    }
    for (const e of data.events) {
      items.push({
        id: `e${e.id}`,
        at: e.created_at,
        kind: 'system',
        tone: e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warning' : 'ai',
        title: e.type,
        note: summarizePayload(e.payload),
      })
    }
    const b = data.billing
    items.push({ id: 'created', at: data.organization.created_at, kind: 'billing', tone: 'accent', title: 'Організацію створено', note: data.organization.owner.email ?? undefined })
    if (b.state) {
      items.push({ id: 'trial-start', at: b.state.trial_started_at, kind: 'billing', tone: 'ai', title: 'Почався тріал' })
      if (Date.parse(b.state.trial_ends_at) < Date.now()) items.push({ id: 'trial-end', at: b.state.trial_ends_at, kind: 'billing', tone: 'warning', title: 'Тріал закінчився' })
    }
    for (const a of b.addons) items.push({ id: `ad${a.key}`, at: a.enabled_at, kind: 'billing', tone: 'success', title: `Модуль активний з цієї дати: ${a.name}` })
    for (const d of b.discounts) items.push({ id: `d${d.id}`, at: d.created_at, kind: 'billing', tone: 'success', title: `Знижка «${d.label}» −${d.percent}%` })
    return items.filter((i) => feedFilter === 'all' || i.kind === feedFilter).sort((x, y) => y.at.localeCompare(x.at))
  }, [data, feedFilter, showViews])

  if (error) {
    return (
      <div className="adm fade-in">
        <Link className="adm-back" to="/admin/organizations">
          <IconArrowLeft size={14} /> Усі організації
        </Link>
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="adm fade-in">
        <div className="adm-loading">
          <IconSpinner size={16} /> Встановлюю з'єднання з організацією…
        </div>
      </div>
    )
  }

  const { organization: org, billing, usage } = data
  const status = billing.state?.plan_status ?? null
  const meta = STATUS_META[status ?? 'none']
  const days = status === 'trial' ? trialDaysLeft(billing.state?.trial_ends_at ?? null) : null
  const trialTotal = billing.state ? Math.max(1, Math.round((Date.parse(billing.state.trial_ends_at) - Date.parse(billing.state.trial_started_at)) / 86_400_000)) : 14
  const seatAddon = billing.catalog.find((c) => c.key === 'extra_seat')
  const seatPrice = seatAddon ? Number(seatAddon.price_monthly) : 5

  return (
    <div className={`adm adm-profile fade-in tone-${meta.tone}`}>
      <Link className="adm-back" to="/admin/organizations">
        <IconArrowLeft size={14} /> Усі організації
      </Link>

      <div className="adm-profile-hero">
        <div className="adm-emblem adm-emblem-xl" aria-hidden="true">
          {orgInitial(org.name)}
        </div>
        <div className="adm-profile-id">
          <div className="adm-eyebrow">
            <span className="adm-pulse" aria-hidden="true" />
            ORGANIZATION · {meta.code}
          </div>
          <h1 className="adm-title">{org.name}</h1>
          <div className="adm-profile-meta">
            <span>{org.owner.email ?? 'власник невідомий'}</span>
            <span>з {formatDate(org.created_at)}</span>
            <button
              type="button"
              className="adm-id"
              onClick={() => {
                void navigator.clipboard?.writeText(org.id)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1400)
              }}
              title="Скопіювати ID"
            >
              <IconDuplicate size={12} />
              {copied ? 'скопійовано' : org.id.slice(0, 8)}
            </button>
          </div>
        </div>
        <div className="adm-hero-badges">
          <span className={`adm-badge tone-${meta.tone}`}>{meta.label.toUpperCase()}</span>
          <span className="adm-badge tone-danger">ROOT</span>
          {days !== null && <span className="adm-badge tone-trial">{days} ДН ТРІАЛУ</span>}
        </div>
      </div>

      <div className="adm-stats adm-stats-6">
        {[
          { label: 'Рахунок / міс', value: usd(billing.bill.net), sub: billing.bill.discountPct > 0 ? `з ${usd(billing.bill.gross)}, −${billing.bill.discountPct}%` : `${billing.bill.subscriberCount.toLocaleString('uk-UA')} підписників`, tone: 'accent' },
          { label: 'Ліди', value: usage.leads.toLocaleString('uk-UA'), sub: `${usage.threads} чатів`, tone: 'ai' },
          { label: 'Повідомлень · 30 дн', value: usage.messages_30d.toLocaleString('uk-UA'), sub: `остання активність ${relativeTime(usage.last_thread_at)}`, tone: 'ai' },
          { label: 'Команда', value: String(org.members.length), sub: 'учасників', tone: 'active' },
          { label: 'Тунелі · ЛГТ · лендінги', value: `${usage.funnels} · ${usage.links} · ${usage.landings}`, sub: 'створено', tone: 'trial' },
          { label: 'Канали', value: String(usage.channels.length), sub: usage.channels.map((c) => CHANNEL_LABELS[c] ?? c).join(' · ') || 'не підключено', tone: 'free' },
        ].map((s, i) => (
          <div key={s.label} className={`adm-stat tone-${s.tone}`} style={{ '--i': i } as React.CSSProperties}>
            <span className="adm-stat-label">{s.label}</span>
            <div className="adm-stat-value">{s.value}</div>
            <div className="adm-stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {actionError && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{actionError}</span>
        </div>
      )}

      <div className="adm-grid">
        <div className="adm-col">
          <Section icon={<IconUsers size={15} />} title="Основне" code="IDENTITY">
            <dl className="adm-dl">
              <div>
                <dt>ID</dt>
                <dd className="adm-mono">{org.id}</dd>
              </div>
              <div>
                <dt>Власник</dt>
                <dd>{org.owner.email ?? '—'}</dd>
              </div>
              <div>
                <dt>Створена</dt>
                <dd>{formatDate(org.created_at, true)}</dd>
              </div>
              <div>
                <dt>Базова валюта</dt>
                <dd>{org.base_currency?.toUpperCase()}</dd>
              </div>
            </dl>
            <ul className="adm-members">
              {org.members.map((m) => (
                <li key={m.id}>
                  <span className="adm-member-dot" aria-hidden="true" />
                  <span className="adm-member-email">{m.email ?? m.id}</span>
                  {m.is_owner && <span className="adm-chip tone-accent">OWNER</span>}
                  <small>з {formatDate(m.created_at)}</small>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={<IconCreditCard size={15} />} title="Білінг" code="BILLING CORE">
            <div className="adm-plan">
              <div className="adm-plan-row">
                <span>Статус плану</span>
                <span className={`adm-status tone-${meta.tone}`}>
                  <i />
                  {meta.label}
                </span>
              </div>
              {billing.state ? (
                <>
                  <div className="adm-plan-row">
                    <span>Тріал</span>
                    <b>
                      {formatDate(billing.state.trial_started_at)} → {formatDate(billing.state.trial_ends_at)}
                    </b>
                  </div>
                  {days !== null && (
                    <div className="adm-trial-track" title={`${days} з ${trialTotal} днів`}>
                      <span style={{ width: `${Math.min(100, (days / trialTotal) * 100)}%` }} />
                    </div>
                  )}
                </>
              ) : (
                <p className="adm-note">Запису білінгу немає — організацію створено до запуску тріалів. Статус можна задати в «Danger zone».</p>
              )}
            </div>

            <h3 className="adm-h3">Підписники</h3>
            <div className="adm-plan-row">
              <span>Підписники: {billing.bill.subscriberCount.toLocaleString('uk-UA')}</span>
              <b>{usd(calcSubscriptionPrice(billing.bill.subscriberCount, 0))}/міс</b>
            </div>
            <p className="adm-note">Перші 2 500 — у базовій ціні $29. Далі +$5 за кожну наступну тисячу (округлення вгору).</p>

            <h3 className="adm-h3">Менеджери</h3>
            <div className="adm-plan-row">
              <div className="adm-qty">
                <button
                  type="button"
                  disabled={busy !== null || billing.bill.managerSeats <= 0}
                  onClick={() => void run('addon-extra_seat', { action: 'set_addon', addonKey: 'extra_seat', enabled: billing.bill.managerSeats - 1 > 0, quantity: Math.max(1, billing.bill.managerSeats - 1) })}
                >
                  −
                </button>
                <span>{billing.bill.managerSeats}</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run('addon-extra_seat', { action: 'set_addon', addonKey: 'extra_seat', enabled: true, quantity: billing.bill.managerSeats + 1 })}
                >
                  {busy === 'addon-extra_seat' ? <IconSpinner size={11} /> : '+'}
                </button>
              </div>
              <b>{usd(seatPrice)}/міс · місце</b>
            </div>

            <div className="adm-bill">
              <div>
                <span>Базова ціна</span>
                <b>{usd(billing.bill.gross)}</b>
              </div>
              <div>
                <span>Знижка</span>
                <b className={billing.bill.discountPct > 0 ? 'is-good' : ''}>{billing.bill.discountPct > 0 ? `−${billing.bill.discountPct}%` : '—'}</b>
              </div>
              <div className="is-total">
                <span>Разом / міс</span>
                <b>{usd(billing.bill.net)}</b>
              </div>
            </div>

            <DiscountsSection orgId={org.id} onChange={load} />

            <h3 className="adm-h3">Історія платежів</h3>
            <div className="adm-empty-note">
              <IconWallet size={14} />
              Платіжного провайдера ще не підключено — у системі немає записів про оплати, лише розрахунковий рахунок вище.
            </div>
          </Section>
        </div>

        <div className="adm-col">
          <Section icon={<IconHistory size={15} />} title="Журнал" code="TELEMETRY" className="adm-feed-section">
            <div className="adm-feed-tools">
              <div className="adm-seg" role="group" aria-label="Тип подій">
                {(
                  [
                    ['all', 'Усе'],
                    ['admin', 'Адмін'],
                    ['system', 'Система'],
                    ['billing', 'Білінг'],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} type="button" className={feedFilter === k ? 'is-on' : ''} onClick={() => setFeedFilter(k)}>
                    {l}
                  </button>
                ))}
              </div>
              <label className="adm-check">
                <input type="checkbox" checked={showViews} onChange={(e) => setShowViews(e.target.checked)} />
                перегляди адмінів
              </label>
            </div>
            {feed.length === 0 ? (
              <div className="adm-empty">Подій немає.</div>
            ) : (
              <ol className="adm-feed">
                {feed.map((item) => (
                  <li key={item.id} className={`tone-${item.tone}`}>
                    <span className="adm-feed-dot" aria-hidden="true" />
                    <div className="adm-feed-body">
                      <div className="adm-feed-top">
                        <b>{item.title}</b>
                        <time dateTime={item.at} title={formatDate(item.at, true)}>
                          {relativeTime(item.at)}
                        </time>
                      </div>
                      <div className="adm-feed-meta">
                        <span className={`adm-chip tone-${item.kind === 'admin' ? 'danger' : item.kind === 'system' ? 'ai' : 'accent'}`}>
                          {item.kind === 'admin' ? 'ADMIN' : item.kind === 'system' ? 'SYSTEM' : 'BILLING'}
                        </span>
                        {item.note && <span className="adm-feed-note">{item.note}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </div>

      <DangerZone
        orgName={org.name}
        status={status}
        trialEndsAt={billing.state?.trial_ends_at ?? null}
        addonsCount={billing.addons.length}
        busy={busy}
        run={run}
      />

      <p className="adm-foot">
        <IconShield size={12} /> Кожна дія й кожен перегляд цієї сторінки записуються в журнал адміністраторів.
      </p>
    </div>
  )
}

function DangerZone({
  orgName,
  status,
  trialEndsAt,
  addonsCount,
  busy,
  run,
}: {
  orgName: string
  status: PlanStatus | null
  trialEndsAt: string | null
  addonsCount: number
  busy: string | null
  run: (key: string, body: Record<string, unknown>, confirmText?: string) => Promise<void>
}) {
  const [nextStatus, setNextStatus] = useState<PlanStatus>(status ?? 'trial')
  const [trialDate, setTrialDate] = useState(() => {
    const base = trialEndsAt && Date.parse(trialEndsAt) > Date.now() ? Date.parse(trialEndsAt) : Date.now()
    return new Date(base + 7 * 86_400_000).toISOString().slice(0, 10)
  })
  const [typed, setTyped] = useState('')

  useEffect(() => setNextStatus(status ?? 'trial'), [status])

  return (
    <section className="adm-danger">
      <header className="adm-danger-head">
        <IconAlert size={16} />
        <h2>Danger zone</h2>
        <span className="adm-code">RESTRICTED · ROOT ONLY</span>
      </header>

      <div className="adm-danger-row">
        <div>
          <b>Статус плану</b>
          <p>Ручна зміна trial / free / active. Нова «Тріал» без чинної дати стартує на 14 днів.</p>
        </div>
        <div className="adm-danger-ctl">
          <div className="adm-seg">
            {(['trial', 'free', 'active'] as const).map((s) => (
              <button key={s} type="button" className={nextStatus === s ? 'is-on' : ''} onClick={() => setNextStatus(s)}>
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="adm-btn-danger"
            disabled={busy !== null || nextStatus === status}
            onClick={() => void run('status', { action: 'set_plan_status', status: nextStatus }, `Змінити статус «${orgName}» на «${STATUS_META[nextStatus].label}»?`)}
          >
            {busy === 'status' ? <IconSpinner size={13} /> : 'Застосувати'}
          </button>
        </div>
      </div>

      <div className="adm-danger-row">
        <div>
          <b>Кінець тріалу</b>
          <p>Продовжити або скоротити тріал — організація повертається в статус «Тріал» до цієї дати.</p>
        </div>
        <div className="adm-danger-ctl">
          <input type="date" className="input" value={trialDate} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setTrialDate(e.target.value)} aria-label="Кінець тріалу" />
          <button
            type="button"
            className="adm-btn-danger"
            disabled={busy !== null || !trialDate}
            onClick={() =>
              void run('trial', { action: 'set_trial_end', trialEndsAt: new Date(`${trialDate}T23:59:59`).toISOString() }, `Встановити кінець тріалу «${orgName}» на ${trialDate}?`)
            }
          >
            {busy === 'trial' ? <IconSpinner size={13} /> : 'Встановити'}
          </button>
        </div>
      </div>

      <div className="adm-danger-row">
        <div>
          <b>Скинути менеджерів</b>
          <p>Прибирає всі оплачувані місця менеджерів ({addonsCount}), статус плану не змінює.</p>
        </div>
        <div className="adm-danger-ctl">
          <button
            type="button"
            className="adm-btn-danger"
            disabled={busy !== null || addonsCount === 0}
            onClick={() => void run('addons', { action: 'remove_addons' }, `Скинути всіх оплачуваних менеджерів «${orgName}»?`)}
          >
            {busy === 'addons' ? <IconSpinner size={13} /> : <IconTrash size={13} />}
            Скинути менеджерів
          </button>
        </div>
      </div>

      <div className="adm-danger-row is-critical">
        <div>
          <b>Призупинити платний доступ</b>
          <p>Те саме, що робить автоматичне завершення тріалу: статус «Free» і скидання оплачуваних місць менеджерів. Дані організації не видаляються.</p>
        </div>
        <div className="adm-danger-ctl adm-danger-ctl-stack">
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`Введіть «${orgName}» для підтвердження`} aria-label="Підтвердження назвою" />
          <button
            type="button"
            className="adm-btn-danger is-solid"
            disabled={busy !== null || typed.trim() !== orgName.trim()}
            onClick={async () => {
              await run('suspend', { action: 'remove_addons' })
              await run('suspend', { action: 'set_plan_status', status: 'free' })
              setTyped('')
            }}
          >
            {busy === 'suspend' ? <IconSpinner size={13} /> : <IconBolt size={13} />}
            Призупинити
          </button>
        </div>
      </div>
    </section>
  )
}

interface OrgDiscount {
  id: string
  label: string
  percent: number
  expires_at: string | null
  created_at: string
}

// Admin view/edit of org_discounts via save-org-discount.ts — a modifier on
// top of the org's own bill, never touching org_billing_state itself.
function DiscountsSection({ orgId, onChange }: { orgId: string; onChange: () => Promise<void> }) {
  const [discounts, setDiscounts] = useState<OrgDiscount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [percent, setPercent] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const call = useCallback(async (body: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) throw new Error('Сесія недійсна, увійдіть знову')
    const res = await fetch('/.netlify/functions/save-org-discount', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, orgId }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Не вдалося виконати дію')
    return json
  }, [orgId])

  const load = useCallback(async () => {
    try {
      const d = await call({ action: 'list' })
      setDiscounts(d.discounts ?? [])
    } catch (err) {
      setError((err as Error).message)
    }
  }, [call])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    const p = Number(percent)
    if (!label.trim() || Number.isNaN(p) || p < 0 || p > 100) {
      setError('Вкажіть назву й відсоток від 0 до 100')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await call({ action: 'create', label: label.trim(), percent: p, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null })
      setLabel('')
      setPercent('')
      setExpiresAt('')
      await Promise.all([load(), onChange()])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function remove(id: string) {
    setDeletingId(id)
    setError(null)
    try {
      await call({ action: 'delete', discountId: id })
      await Promise.all([load(), onChange()])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <h3 className="adm-h3">Знижки</h3>
      {discounts.length === 0 ? (
        <p className="adm-note">Знижок ще немає.</p>
      ) : (
        <ul className="adm-discounts">
          {discounts.map((d) => {
            const expired = !!d.expires_at && Date.parse(d.expires_at) < Date.now()
            return (
              <li key={d.id} className={expired ? 'is-expired' : ''}>
                <span className="adm-chip tone-active">−{d.percent}%</span>
                <span className="adm-discount-label">{d.label}</span>
                <small>{d.expires_at ? `${expired ? 'прострочено' : 'до'} ${formatDate(d.expires_at)}` : 'безстроково'}</small>
                <button type="button" className="adm-icon-btn" onClick={() => void remove(d.id)} disabled={deletingId === d.id} aria-label={`Видалити знижку ${d.label}`}>
                  {deletingId === d.id ? <IconSpinner size={13} /> : <IconTrash size={13} />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <form className="adm-discount-form" onSubmit={add}>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Назва знижки" aria-label="Назва знижки" />
        <input className="input" type="number" min={0} max={100} step="0.01" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="%" aria-label="Відсоток" />
        <input className="input" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Діє до" />
        <button type="submit" className="adm-btn" disabled={submitting}>
          {submitting ? <IconSpinner size={13} /> : <IconPlus size={13} />}
          Додати
        </button>
      </form>
      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}
    </>
  )
}
