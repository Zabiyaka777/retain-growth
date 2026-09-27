import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { IconAlert, IconCheckCircle, IconChevronDown, IconChevronUp, IconSpinner, IconWallet } from './icons'

interface MonoAccount {
  id: string
  test_mode: boolean
  merchant_id: string | null
  merchant_name: string | null
  edrpou: string | null
  verified_at: string | null
}

async function accountApi(body: Record<string, unknown>) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Сесія недійсна, увійдіть знову')
  const res = await fetch('/.netlify/functions/payment-account', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Не вдалося виконати дію')
  return json as { account?: MonoAccount }
}

function formatDateTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
}

/**
 * Settings → Інтеграції: the org's own Plata by Mono, for taking payments
 * from its leads (links sent from the chat). The token is sent once to
 * payment-account.ts, checked against monobank and kept in Vault — this
 * component never gets it back.
 */
export default function MonoIntegration() {
  const { session } = useAuth()
  const [account, setAccount] = useState<MonoAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [testMode, setTestMode] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [replacing, setReplacing] = useState(false)

  useEffect(() => {
    if (!session) return
    supabase
      .from('org_payment_accounts')
      .select('id, test_mode, merchant_id, merchant_name, edrpou, verified_at')
      .eq('provider', 'monobank')
      .maybeSingle()
      .then(({ data }) => {
        setAccount((data as MonoAccount | null) ?? null)
        setGuideOpen(!data)
        setLoading(false)
      })
  }, [session])

  async function run(key: string, body: Record<string, unknown>, ok?: string) {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      const res = await accountApi(body)
      if (body.action === 'disconnect') setAccount(null)
      else if (res.account) setAccount(res.account)
      if (ok) setNotice(ok)
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!token.trim()) return
    const saved = await run('save', { action: 'save', token: token.trim(), testMode }, 'Підключено — monobank підтвердив токен')
    if (saved) {
      setToken('')
      setReplacing(false)
      setGuideOpen(false)
    }
  }

  const showForm = !account || replacing

  return (
    <div className="card mono-card">
      <div className="mono-head">
        <span className="mono-logo" aria-hidden="true">
          <IconWallet size={18} />
        </span>
        <div>
          <h3>Plata by Mono</h3>
          <p>Приймайте оплату від лідів: посилання на оплату monobank прямо з чату, статус оплати — в профілі ліда.</p>
        </div>
      </div>

      {loading ? (
        <p className="settings-row-hint">Завантаження…</p>
      ) : (
        <>
          {account && (
            <div className="mono-status">
              <div className="mono-status-top">
                <span className="mono-dot" aria-hidden="true" />
                <b>Підключено</b>
                {account.test_mode && <span className="mono-test-badge">ТЕСТОВИЙ РЕЖИМ</span>}
              </div>
              <dl className="mono-dl">
                <div>
                  <dt>Мерчант</dt>
                  <dd>{account.merchant_name ?? '—'}</dd>
                </div>
                <div>
                  <dt>ЄДРПОУ / ІПН</dt>
                  <dd>{account.edrpou ?? '—'}</dd>
                </div>
                <div>
                  <dt>Перевірено</dt>
                  <dd>{formatDateTime(account.verified_at)}</dd>
                </div>
              </dl>
              <label className="mono-toggle">
                <input
                  type="checkbox"
                  checked={account.test_mode}
                  disabled={busy !== null}
                  onChange={(e) =>
                    void run('mode', { action: 'set_test_mode', testMode: e.target.checked }, e.target.checked ? 'Нові рахунки будуть тестовими' : 'Нові рахунки будуть бойовими')
                  }
                />
                <span>
                  Тестовий режим
                  <small>Рахунки позначаються як тестові й не рахуються в оплатах і продажах. Вмикайте разом із тестовим токеном.</small>
                </span>
              </label>
              <div className="mono-actions">
                <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void run('verify', { action: 'verify' }, 'Зв’язок з monobank працює')}>
                  {busy === 'verify' ? <IconSpinner size={15} /> : 'Перевірити підключення'}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setReplacing((v) => !v)}>
                  {replacing ? 'Скасувати' : 'Замінити токен'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger-ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm('Відключити Plata by Mono? Нові посилання на оплату створювати не вийде, а статуси вже виставлених рахунків перестануть оновлюватись. Історія платежів збережеться.'))
                      void run('disconnect', { action: 'disconnect' }, 'Відключено')
                  }}
                >
                  {busy === 'disconnect' ? <IconSpinner size={15} /> : 'Відключити'}
                </button>
              </div>
            </div>
          )}

          {showForm && (
            <form className="auth-form mono-form" onSubmit={handleSave} autoComplete="off">
              <div className="field">
                <label htmlFor="mono-token">{account ? 'Новий токен' : 'Токен Plata by Mono'}</label>
                <input
                  id="mono-token"
                  className="input input-masked"
                  type="text"
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Вставте X-Token з кабінету monobank"
                />
              </div>
              {!account && (
                <label className="mono-toggle">
                  <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
                  <span>
                    Це тестовий токен
                    <small>з api.monobank.ua — гроші не списуються, рахунки позначаються як тестові</small>
                  </span>
                </label>
              )}
              <button type="submit" className="btn btn-primary" disabled={busy !== null || !token.trim()} style={{ alignSelf: 'flex-start' }}>
                {busy === 'save' ? <IconSpinner size={16} /> : account ? 'Замінити токен' : 'Підключити'}
              </button>
              <p className="settings-row-hint">Токен перевіряється в monobank перед збереженням і зберігається зашифровано — після збереження його не видно навіть вам.</p>
            </form>
          )}

          {error && (
            <div className="alert alert-error">
              <IconAlert size={16} />
              <span>{error}</span>
            </div>
          )}
          {notice && !error && (
            <div className="alert alert-info">
              <IconCheckCircle size={16} />
              <span>{notice}</span>
            </div>
          )}

          <button type="button" className="mono-guide-toggle" onClick={() => setGuideOpen((v) => !v)} aria-expanded={guideOpen}>
            {guideOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
            Як підключити — покрокова інструкція
          </button>
          {guideOpen && (
            <ol className="mono-guide">
              <li>
                <b>Потрібен рахунок ФОП або юрособи в monobank</b> з підключеним інтернет-еквайрингом (Plata by Mono). Якщо його ще немає — подайте заявку в застосунку monobank
                (розділ для бізнесу) або на <a href="https://www.monobank.ua/business" target="_blank" rel="noopener noreferrer">monobank.ua/business</a>.
              </li>
              <li>
                <b>Відкрийте веб-кабінет</b> <a href="https://web.monobank.ua" target="_blank" rel="noopener noreferrer">web.monobank.ua</a> і увійдіть через застосунок monobank.
              </li>
              <li>
                <b>Знайдіть розділ еквайрингу</b> (Інтернет-еквайринг / Plata by Mono) → налаштування API → <b>токен (X-Token)</b>. Скопіюйте його повністю — це довгий рядок
                латиницею й цифрами.
              </li>
              <li>
                <b>Вставте токен у поле вище</b> і натисніть «Підключити». Ми одразу звіримося з monobank: якщо все гаразд, тут з’явиться назва вашого мерчанта й ЄДРПОУ/ІПН —
                переконайтесь, що це ваш бізнес.
              </li>
              <li>
                <b>Перевірте на тесті.</b> Хочете спершу без реальних грошей — візьміть тестовий токен на{' '}
                <a href="https://api.monobank.ua" target="_blank" rel="noopener noreferrer">api.monobank.ua</a>, підключіть його з галочкою «Це тестовий токен», у чаті створіть
                рахунок кнопкою «Рахунок» і оплатіть будь-якою валідною за Луном карткою (напр. 4242 4242 4242 4242). Статус «Оплачено» з’явиться в чаті й у профілі ліда.
                Потім замініть токен на бойовий і вимкніть тестовий режим.
              </li>
              <li>
                <b>Нічого не треба налаштовувати в кабінеті monobank окремо</b> — адресу для сповіщень про оплату ми передаємо з кожним рахунком самі, а кожне сповіщення
                перевіряємо за цифровим підписом monobank.
              </li>
            </ol>
          )}
        </>
      )}
    </div>
  )
}
