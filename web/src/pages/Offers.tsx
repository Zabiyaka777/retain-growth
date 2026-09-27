import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { IconAlert, IconPlus, IconSpinner, IconTag, IconTrash } from '../components/icons'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

async function saveOffer(body: Record<string, unknown>) {
  const token = await getAccessToken()
  if (!token) throw new Error('Сесія недійсна, увійдіть знову')
  const res = await fetch('/.netlify/functions/save-offer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Не вдалося зберегти оффер')
  return json
}

interface Offer {
  id: string
  name: string
  description: string | null
  price_amount: number
  ccy: number
  kind: 'one_time' | 'recurring'
  interval: 'week' | 'month' | 'year' | null
  image_url: string | null
  is_active: boolean
}

const INTERVAL_LABEL: Record<'week' | 'month' | 'year', string> = { week: 'тиждень', month: 'місяць', year: 'рік' }

function formatMoney(minorAmount: number, ccy: number): string {
  const major = minorAmount / 100
  const symbol = ccy === 980 ? '₴' : ccy === 840 ? '$' : ccy === 978 ? '€' : `#${ccy}`
  return `${Number.isInteger(major) ? major : major.toFixed(2)} ${symbol}`
}

function emptyOffer(): Omit<Offer, 'id'> {
  return { name: '', description: '', price_amount: 0, ccy: 980, kind: 'one_time', interval: null, image_url: '', is_active: true }
}

function OfferForm({ initial, onSaved, onCancel }: { initial: Offer | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<Omit<Offer, 'id'>>(initial ?? emptyOffer())
  const [priceInput, setPriceInput] = useState(initial ? String(initial.price_amount / 100) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await saveOffer({
        id: initial?.id,
        name: form.name,
        description: form.description,
        priceAmount: Number(priceInput.replace(',', '.')),
        ccy: form.ccy,
        kind: form.kind,
        interval: form.kind === 'recurring' ? form.interval : null,
        imageUrl: form.image_url,
        isActive: form.is_active,
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem', maxWidth: 480 }} onSubmit={handleSubmit}>
      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}
      <div className="field">
        <label>Назва</label>
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Курс «Старт», потік 12" required />
      </div>
      <div className="field">
        <label>Опис (опційно)</label>
        <textarea className="input" rows={2} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Ціна, грн</label>
          <input className="input" inputMode="decimal" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} placeholder="0,00" required />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Тип</label>
          <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Offer['kind'], interval: e.target.value === 'recurring' ? form.interval ?? 'month' : null })}>
            <option value="one_time">Разовий</option>
            <option value="recurring">Рекурентний</option>
          </select>
        </div>
      </div>
      {form.kind === 'recurring' && (
        <div className="field">
          <label>Інтервал списання</label>
          <select className="input" value={form.interval ?? 'month'} onChange={(e) => setForm({ ...form, interval: e.target.value as 'week' | 'month' | 'year' })}>
            <option value="week">Щотижня</option>
            <option value="month">Щомісяця</option>
            <option value="year">Щороку</option>
          </select>
        </div>
      )}
      <div className="field">
        <label>Зображення (URL, опційно)</label>
        <input className="input" value={form.image_url ?? ''} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="https://…" />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Активний (показувати в каталозі при виборі оффера)
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? <IconSpinner size={14} /> : 'Зберегти'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Скасувати
        </button>
      </div>
    </form>
  )
}

export default function Offers() {
  const [offers, setOffers] = useState<Offer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Offer | 'new' | null>(null)

  async function load() {
    setLoading(true)
    const { data, error: loadError } = await supabase.from('offers').select('*').order('created_at', { ascending: false })
    if (loadError) {
      setError(loadError.message)
    } else {
      setOffers((data ?? []) as Offer[])
      setError(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function deleteOffer(id: string) {
    if (!window.confirm('Видалити цей оффер?')) return
    try {
      await saveOffer({ id, delete: true })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
        <IconSpinner size={20} />
      </div>
    )
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            <IconTag size={20} style={{ marginRight: '0.5rem', verticalAlign: '-3px' }} />
            Офери
          </h1>
          <p className="page-description">
            Каталог товарів і послуг. Оффер можна вибрати при оплаті в чаті або на вузлі «Оплата» в конструкторі тунелів — ціна і назва
            беруться звідси.
          </p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="settings-group">
        <header className="settings-group-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
          <div>
            <h2>Каталог</h2>
            <p>Разові офери оплачуються одним рахунком. Рекурентні — зберігають картку й списують автоматично за обраним інтервалом.</p>
          </div>
          {editing === null && (
            <button type="button" className="btn btn-secondary" style={{ flexShrink: 0 }} onClick={() => setEditing('new')}>
              <IconPlus size={13} /> Новий оффер
            </button>
          )}
        </header>

        {offers.length === 0 && editing === null && <p className="settings-row-hint">Офферів ще немає. Приклад: «Курс «Старт»» — 990 ₴, разовий.</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {offers.map((o) => (
            <div key={o.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 0.875rem', opacity: o.is_active ? 1 : 0.6 }}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
                <b>{o.name}</b>
                <small className="settings-row-hint">
                  {formatMoney(o.price_amount, o.ccy)}
                  {o.kind === 'recurring' && o.interval ? ` · ${INTERVAL_LABEL[o.interval]}` : ' · разовий'}
                  {!o.is_active ? ' · неактивний' : ''}
                </small>
              </div>
              <div style={{ display: 'flex', gap: '0.375rem' }}>
                <button type="button" className="btn-icon-ghost" onClick={() => setEditing(o)} aria-label="Редагувати">
                  ✎
                </button>
                <button type="button" className="btn-icon-ghost" onClick={() => deleteOffer(o.id)} aria-label="Видалити">
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {editing !== null && (
          <OfferForm
            initial={editing === 'new' ? null : editing}
            onSaved={() => {
              setEditing(null)
              void load()
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </div>
    </div>
  )
}
