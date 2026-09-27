import { useState } from 'react'
import { IconBubble, IconCheckCircle, IconInstagram, IconLink, IconPhone, IconSend } from './icons'
import { copyText } from './CopyValue'

// Wider than buildLeadGenUrls' own channel set on purpose: this list is also
// the generic channel label/icon lookup Crm.tsx and Chats.tsx read for ANY
// lead, not just ones that arrived through a lead-gen link. Instagram has no
// click-to-message link tool yet (see buildLeadGenUrls below), but its leads
// still need a label and icon here.
export const CHANNELS: { key: 'telegram' | 'whatsapp' | 'fbm' | 'instagram'; label: string; icon: typeof IconSend }[] = [
  { key: 'telegram', label: 'Telegram', icon: IconSend },
  { key: 'whatsapp', label: 'WhatsApp', icon: IconPhone },
  { key: 'fbm', label: 'FB Messenger', icon: IconBubble },
  { key: 'instagram', label: 'Instagram', icon: IconInstagram },
]

// customDomain: the link's own verified domain (lead_gen_links.custom_domain)
// — edge-functions/custom-domain.ts 302s its root to /r/:ref_token with the
// query string intact, so ?ch= (and any fbclid/utm) carries through. Pass it
// only once verified: before that the domain doesn't reach us over HTTPS.
export function buildLeadGenUrls(refToken: string, customDomain?: string | null): Record<'telegram' | 'whatsapp' | 'fbm', string> {
  if (customDomain) {
    const base = `https://${customDomain}/`
    return { telegram: `${base}?ch=telegram`, whatsapp: `${base}?ch=whatsapp`, fbm: `${base}?ch=fbm` }
  }
  const origin = window.location.origin
  return {
    telegram: `${origin}/r/${refToken}?ch=telegram`,
    whatsapp: `${origin}/r/${refToken}?ch=whatsapp`,
    fbm: `${origin}/r/${refToken}?ch=fbm`,
  }
}

// Small icon-only copy buttons for the list view — click copies straight to
// the clipboard, no navigation, with a transient "Скопійовано" label.
export function ChannelCopyButtons({
  refToken,
  customDomain,
  onCopy,
}: {
  refToken: string
  customDomain?: string | null
  onCopy?: () => void
}) {
  const urls = buildLeadGenUrls(refToken, customDomain)
  // Instagram has no click-to-message link tool yet (see buildLeadGenUrls) —
  // filtered out here rather than widening CHANNELS' consumers everywhere.
  return (
    <div style={{ display: 'flex', gap: '0.375rem' }}>
      {CHANNELS.filter((c) => c.key in urls).map(({ key, label, icon: Icon }) => (
        <ChannelCopyIconButton key={key} label={label} icon={Icon} url={urls[key as keyof typeof urls]} onCopy={onCopy} />
      ))}
    </div>
  )
}

function ChannelCopyIconButton({
  label,
  icon: Icon,
  url,
  onCopy,
}: {
  label: string
  icon: typeof IconSend
  url: string
  onCopy?: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!(await copyText(url))) return
    setCopied(true)
    onCopy?.()
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={handleClick}
        title={`Копіювати посилання — ${label}\n${url}`}
        aria-label={`Копіювати посилання ${label}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: copied ? 'var(--success-soft)' : 'var(--bg-subtle)',
          color: copied ? 'var(--success)' : 'var(--fg-muted)',
          cursor: 'pointer',
        }}
      >
        {copied ? <IconCheckCircle size={14} /> : <Icon size={14} />}
      </button>
      {copied && (
        <span
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 0.375rem)',
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: '0.6875rem',
            fontWeight: 600,
            color: 'var(--success)',
            background: 'var(--surface-active)',
            padding: '0.1875rem 0.5rem',
            borderRadius: 6,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          Скопійовано
        </span>
      )}
    </div>
  )
}

function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    if (!(await copyText(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button type="button" className="btn-icon-ghost" onClick={handleCopy} aria-label="Скопіювати посилання">
      {copied ? <IconCheckCircle size={14} /> : <IconLink size={14} />}
    </button>
  )
}

// Full card with all 3 ready-to-use URLs — used on the create/view page.
export function LeadGenLinkCard({ name, meta, refToken }: { name: string; meta: string; refToken: string }) {
  const urls = buildLeadGenUrls(refToken)
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div>
        <span className="funnel-row-name">{name}</span>
        <p className="flow-node-hint" style={{ margin: 0 }}>
          {meta}
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {CHANNELS.filter((c) => c.key in urls).map(({ key, label, icon: Icon }) => (
          <div
            key={key}
            style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.625rem', borderRadius: 8, background: 'var(--bg-subtle)' }}
          >
            <Icon size={16} />
            <span style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', minWidth: 96 }}>{label}</span>
            <code style={{ flex: 1, fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {urls[key as keyof typeof urls]}
            </code>
            <CopyTextButton text={urls[key as keyof typeof urls]} />
          </div>
        ))}
      </div>
    </div>
  )
}
