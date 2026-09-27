import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabaseClient'
import { IconSpinner } from './icons'
import { CopyValue } from './CopyValue'

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export type DomainStatus = 'pending' | 'verified' | null

// Second-level suffixes a tenant is likely to register under — without them
// "shop.com.ua" would read as the subdomain "shop" of "com.ua".
const TWO_PART_SUFFIXES = new Set(['com.ua', 'org.ua', 'net.ua', 'in.ua', 'kiev.ua', 'kyiv.ua', 'co.uk', 'org.uk', 'com.pl', 'com.au'])

// What goes into the registrar's "Host / Ім'я" column: everything left of the
// registered domain, or "@" for the bare domain itself.
function dnsHostFor(domain: string): { host: string; apex: boolean } {
  const labels = domain.split('.')
  const baseLen = TWO_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2
  if (labels.length <= baseLen) return { host: '@', apex: true }
  return { host: labels.slice(0, labels.length - baseLen).join('.'), apex: false }
}

interface Props {
  // Which save-*-domain / check-*-domain pair to call (both are wrappers
  // around netlify/functions/_shared/netlify-domains.ts).
  entity: 'landing' | 'link'
  entityId: string
  initialDomain: string | null
  initialStatus: DomainStatus
  inputId: string
  label: string
  // The only step of the how-to that differs: what "Підключено" means for
  // this entity (a landing renders there, a link sends straight to a messenger).
  lastStep: ReactNode
  verifiedText: (domain: string) => ReactNode
  // Extra content once a domain is attached — e.g. a link's ready URLs.
  renderAttached?: (domain: string, status: DomainStatus) => ReactNode
  // Every saved/checked change of domain or status — lets the owner show
  // the domain elsewhere (e.g. next to the public URL) only once verified.
  onChange?: (domain: string, status: DomainStatus) => void
}

// The whole "Свій домен" block — how-to, input, bind/unbind/check, status and
// the DNS record to copy. Mounted only once the owning row has loaded, so the
// initial* props are the saved state; from then on it owns that state itself
// (a domain is applied immediately through its own buttons, never batched
// into the parent form's save).
export default function CustomDomainPanel({
  entity,
  entityId,
  initialDomain,
  initialStatus,
  inputId,
  label,
  lastStep,
  verifiedText,
  renderAttached,
  onChange,
}: Props) {
  const [customDomain, setCustomDomain] = useState(initialDomain ?? '')
  const [domainInput, setDomainInput] = useState(initialDomain ?? '')
  const [domainStatus, setDomainStatus] = useState<DomainStatus>(initialStatus)
  const [dnsTarget, setDnsTarget] = useState('')
  const [savingDomain, setSavingDomain] = useState(false)
  const [checkingDomain, setCheckingDomain] = useState(false)
  const [domainError, setDomainError] = useState<string | null>(null)

  const idKey = entity === 'landing' ? 'landingPageId' : 'linkId'

  // A pending domain needs its CNAME value on screen, and that value comes
  // only from the backend — so ask once quietly on open (which also picks up
  // DNS that propagated while the editor was closed).
  useEffect(() => {
    if (initialDomain && initialStatus !== 'verified') void checkDomain({ silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveDomain(next: string | null) {
    setSavingDomain(true)
    setDomainError(null)
    const accessToken = await getAccessToken()
    if (!accessToken) {
      setDomainError('Сесія недійсна, увійдіть знову')
      setSavingDomain(false)
      return
    }
    try {
      const res = await fetch(`/.netlify/functions/save-${entity}-domain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ [idKey]: entityId, customDomain: next }),
      })
      const data = await res.json()
      if (!res.ok) {
        setDomainError(data.error ?? 'Не вдалося зберегти домен')
      } else {
        setCustomDomain(data.customDomain ?? '')
        setDomainInput(data.customDomain ?? '')
        setDomainStatus(data.status ?? null)
        if (data.dnsTarget) setDnsTarget(data.dnsTarget)
        onChange?.(data.customDomain ?? '', data.status ?? null)
      }
    } catch {
      setDomainError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setSavingDomain(false)
    }
  }

  // silent: the automatic check on open — updates status and the CNAME value
  // but never greets the tenant with an error they didn't ask for.
  async function checkDomain({ silent = false }: { silent?: boolean } = {}) {
    setCheckingDomain(true)
    setDomainError(null)
    const accessToken = await getAccessToken()
    if (!accessToken) {
      if (!silent) setDomainError('Сесія недійсна, увійдіть знову')
      setCheckingDomain(false)
      return
    }
    try {
      const res = await fetch(`/.netlify/functions/check-${entity}-domain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ [idKey]: entityId }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (!silent) setDomainError(data.error ?? 'Не вдалося перевірити домен')
      } else {
        setDomainStatus(data.status ?? null)
        if (data.dnsTarget) setDnsTarget(data.dnsTarget)
        onChange?.(customDomain, data.status ?? null)
        if (silent) return
        if (!data.dnsResolved) setDomainError('DNS ще не вказує на нас — перевірте запис і спробуйте ще раз за кілька хвилин')
        else if (!data.sslIssued) setDomainError('DNS налаштовано, сертифікат ще видається — спробуйте перевірити ще раз за хвилину')
      }
    } catch {
      if (!silent) setDomainError('Мережева помилка. Спробуйте ще раз')
    } finally {
      setCheckingDomain(false)
    }
  }

  return (
    <>
      <details className="lpe-howto">
        <summary>Як підключити</summary>
        <ol>
          <li>
            Якщо домену ще немає — купіть на будь-якому реєстраторі (Namecheap, GoDaddy або український imena.ua). Кілька хвилин,
            зазвичай $10–15/рік.
          </li>
          <li>
            Найпростіше — під’єднати піддомен (наприклад <code>promo.вашдомен.com</code> чи <code>go.вашдомен.com</code>), а не голий
            домен. Впишіть його в поле нижче і натисніть «Прив’язати».
          </li>
          <li>
            Зайдіть у DNS-налаштування свого домену в реєстратора (розділ зазвичай зветься «DNS», «Управління записами» або «DNS Zone
            Editor») і додайте запис:
            <ul>
              <li>
                Тип: <code>CNAME</code>
              </li>
              <li>
                Host / Ім’я: піддомен, який ви вписали (наприклад{' '}
                <code>{customDomain && !dnsHostFor(customDomain).apex ? dnsHostFor(customDomain).host : 'promo'}</code>)
              </li>
              <li>
                Значення:{' '}
                {customDomain && dnsTarget ? (
                  <>
                    <code>{dnsTarget}</code> <CopyValue text={dnsTarget} />
                  </>
                ) : customDomain ? (
                  'натисніть «Перевірити», щоб побачити'
                ) : (
                  'з’явиться нижче після прив’язки'
                )}
              </li>
            </ul>
          </li>
          <li>
            Якщо потрібен саме голий домен без піддомену — CNAME на корені більшість реєстраторів не дозволяють. Потрібен запис ALIAS
            або ANAME з тим самим значенням; якщо такого пункту нема — напишіть у підтримку реєстратора з проханням прописати корінь
            домену на Netlify.
          </li>
          <li>DNS оновлюється не миттєво — від кількох хвилин до кількох годин.</li>
          <li>{lastStep}</li>
        </ol>
      </details>
      <div className="field">
        <label htmlFor={inputId}>{label}</label>
        <div className="input-wrap" style={{ alignItems: 'center' }}>
          <input
            id={inputId}
            className="input"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value.trim().toLowerCase())}
            placeholder="promo.вашдомен.com"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={savingDomain || !domainInput.trim() || domainInput.trim() === customDomain}
            onClick={() => saveDomain(domainInput.trim())}
          >
            {savingDomain ? <IconSpinner size={14} /> : 'Прив’язати'}
          </button>
          {customDomain && (
            <button type="button" className="btn btn-ghost" disabled={savingDomain} onClick={() => saveDomain(null)}>
              Відв’язати
            </button>
          )}
          {customDomain && (
            <button type="button" className="btn btn-secondary" disabled={checkingDomain} onClick={() => checkDomain()}>
              {checkingDomain ? <IconSpinner size={14} /> : 'Перевірити'}
            </button>
          )}
        </div>

        {customDomain && (
          <p className="flow-node-hint" style={{ margin: '0.5rem 0 0', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span className={`badge ${domainStatus === 'verified' ? 'badge-success' : 'badge-warning'}`}>
              {domainStatus === 'verified' ? 'Підключено' : 'Очікує DNS'}
            </span>
            {domainStatus === 'verified' ? (
              <span>{verifiedText(customDomain)}</span>
            ) : (
              <span>Додайте у DNS вашого домену запис нижче, потім натисніть «Перевірити»</span>
            )}
          </p>
        )}
        {customDomain && domainStatus !== 'verified' && (
          <div className="lpe-dns-record">
            <span>
              Тип: <code>{dnsHostFor(customDomain).apex ? 'ALIAS / ANAME' : 'CNAME'}</code>
            </span>
            <span className="sep">·</span>
            <span>
              Host: <code>{dnsHostFor(customDomain).host}</code>
            </span>
            <span className="sep">·</span>
            <span className="lpe-dns-value">
              Значення:{' '}
              {dnsTarget ? (
                <>
                  <code>{dnsTarget}</code>
                  <CopyValue text={dnsTarget} />
                </>
              ) : checkingDomain ? (
                <IconSpinner size={12} />
              ) : (
                'натисніть «Перевірити», щоб отримати'
              )}
            </span>
          </div>
        )}
        {domainError && (
          <p className="flow-node-hint" style={{ margin: '0.5rem 0 0', color: 'var(--danger)' }}>
            {domainError}
          </p>
        )}
        {customDomain && renderAttached?.(customDomain, domainStatus)}
      </div>
    </>
  )
}
