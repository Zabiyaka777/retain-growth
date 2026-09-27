import { useEffect, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { IconAlert, IconClose, IconSpinner, IconSync, IconWallet } from './icons'
import { PAYMENT_STATUS, formatUah, usePayments, type PaymentRow } from '../lib/payments'

async function paymentApi(body: Record<string, unknown>) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Сесія недійсна, увійдіть знову')
  const res = await fetch('/.netlify/functions/create-payment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Не вдалося виконати дію')
  return json as { message?: string; payment?: PaymentRow }
}

export function PaymentList({ payments, onChanged }: { payments: PaymentRow[]; onChanged?: () => void }) {
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (payments.length === 0) return null
  return (
    <>
      <ul className="pay-list">
        {payments.map((p) => {
          const s = PAYMENT_STATUS[p.status]
          return (
            <li key={p.id} className={`tone-${s.tone}`}>
              <div className="pay-list-main">
                <b>{formatUah(p.final_amount && p.final_amount > 0 ? p.final_amount : p.amount)}</b>
                <span>{p.destination}</span>
              </div>
              <div className="pay-list-side">
                <span className="pay-status">
                  <i />
                  {s.label}
                </span>
                {p.test_mode && <span className="pay-test">ТЕСТ</span>}
                {p.status !== 'success' && p.status !== 'expired' && (
                  <button
                    type="button"
                    className="pay-refresh"
                    title="Оновити статус з monobank"
                    aria-label="Оновити статус"
                    disabled={refreshing === p.id}
                    onClick={async () => {
                      setRefreshing(p.id)
                      setError(null)
                      try {
                        await paymentApi({ action: 'refresh', paymentId: p.id })
                        onChanged?.()
                      } catch (err) {
                        setError((err as Error).message)
                      } finally {
                        setRefreshing(null)
                      }
                    }}
                  >
                    {refreshing === p.id ? <IconSpinner size={12} /> : <IconSync size={12} />}
                  </button>
                )}
              </div>
              <small className="pay-list-date">
                {new Date(p.paid_at ?? p.created_at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                {p.failure_reason ? ` · ${p.failure_reason}` : ''}
              </small>
            </li>
          )
        })}
      </ul>
      {error && <p className="pay-error">{error}</p>}
    </>
  )
}

/**
 * «Рахунок» in the chat composer: creates an invoice through the org's own
 * Plata by Mono and drops the payment message into the reply box — the
 * manager sends it like any other message, so nothing goes to the lead
 * without them seeing it first.
 */
export function PaymentLinkButton({ threadId, onInsert }: { threadId: string; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-secondary btn-icon" onClick={() => setOpen(true)} title="Рахунок на оплату (Plata by Mono)" aria-label="Створити рахунок на оплату">
        <IconWallet size={16} />
      </button>
      {open &&
        createPortal(
          <PaymentLinkModal
            threadId={threadId}
            onClose={() => setOpen(false)}
            onCreated={(text) => {
              onInsert(text)
              setOpen(false)
            }}
          />,
          document.body,
        )}
    </>
  )
}

function PaymentLinkModal({ threadId, onClose, onCreated }: { threadId: string; onClose: () => void; onCreated: (text: string) => void }) {
  const [account, setAccount] = useState<{ test_mode: boolean; merchant_name: string | null } | null | undefined>(undefined)
  const [amount, setAmount] = useState('')
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { payments, reload } = usePayments({ threadId })

  useEffect(() => {
    void supabase
      .from('org_payment_accounts')
      .select('test_mode, merchant_name')
      .eq('provider', 'monobank')
      .maybeSingle()
      .then(({ data }) => setAccount(data ?? null))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = Number(amount.replace(',', '.').replace(/\s/g, ''))
    if (!Number.isFinite(value) || value < 1) {
      setError('Вкажіть суму від 1 грн')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await paymentApi({ action: 'create', threadId, amount: value, destination: destination.trim() })
      if (res.message) onCreated(res.message)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card pay-modal" role="dialog" aria-label="Рахунок на оплату" onClick={(e) => e.stopPropagation()}>
        <div className="pay-modal-head">
          <span className="pay-modal-icon" aria-hidden="true">
            <IconWallet size={16} />
          </span>
          <div>
            <h3 className="modal-title">Рахунок на оплату</h3>
            <p>Plata by Mono{account?.merchant_name ? ` · ${account.merchant_name}` : ''}</p>
          </div>
          {account?.test_mode && <span className="pay-test">ТЕСТОВИЙ РЕЖИМ</span>}
          <button type="button" className="btn-icon-ghost" onClick={onClose} aria-label="Закрити">
            <IconClose size={14} />
          </button>
        </div>

        {account === undefined ? (
          <p className="settings-row-hint">Завантаження…</p>
        ) : account === null ? (
          <div className="alert alert-info">
            <IconAlert size={16} />
            <span>
              Plata by Mono ще не підключено. <Link to="/dashboard/settings">Підключити в Налаштуваннях → Інтеграції</Link>
            </span>
          </div>
        ) : (
          <form className="pay-form" onSubmit={submit}>
            <div className="pay-amount">
              <input
                className="input"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                aria-label="Сума, грн"
                autoFocus
              />
              <span>грн</span>
            </div>
            <input
              className="input"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              maxLength={200}
              placeholder="Призначення: напр. «Курс «Старт», потік 12»"
              aria-label="Призначення платежу"
            />
            <p className="settings-row-hint">
              Посилання дійсне 7 днів. Повідомлення з ним з’явиться в полі відповіді — перевірте й надішліть як звичайно. Статус оплати оновиться тут і в профілі ліда.
            </p>
            {error && (
              <div className="alert alert-error">
                <IconAlert size={16} />
                <span>{error}</span>
              </div>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || !amount.trim() || !destination.trim()}>
              {busy ? <IconSpinner size={15} /> : 'Створити посилання'}
            </button>
          </form>
        )}

        {payments.length > 0 && (
          <div className="pay-history">
            <div className="pay-history-title">Рахунки в цьому чаті</div>
            <PaymentList payments={payments} onChanged={reload} />
          </div>
        )}
      </div>
    </div>
  )
}
