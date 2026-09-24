import { useState } from 'react'
import { IconBubble, IconCheckCircle, IconLink, IconPhone, IconSend } from './icons'

export const CHANNELS: { key: 'telegram' | 'whatsapp' | 'fbm'; label: string; icon: typeof IconSend }[] = [
  { key: 'telegram', label: 'Telegram', icon: IconSend },
  { key: 'whatsapp', label: 'WhatsApp', icon: IconPhone },
  { key: 'fbm', label: 'FB Messenger', icon: IconBubble },
]

export function buildLeadGenUrls(refToken: string): Record<'telegram' | 'whatsapp' | 'fbm', string> {
  const origin = window.location.origin
  return {
    telegram: `${origin}/r/${refToken}?ch=telegram`,
    whatsapp: `${origin}/r/${refToken}?ch=whatsapp`,
    fbm: `${origin}/r/${refToken}?ch=fbm`,
  }
}

// Small icon-only copy buttons for the list view — click copies straight to
// the clipboard, no navigation, with a transient "Скопійовано" label.
export function ChannelCopyButtons({ refToken, onCopy }: { refToken: string; onCopy?: () => void }) {
  const urls = buildLeadGenUrls(refToken)
  return (
    <div style={{ display: 'flex', gap: '0.375rem' }}>
      {CHANNELS.map(({ key, label, icon: Icon }) => (
        <ChannelCopyIconButton key={key} label={label} icon={Icon} url={urls[key]} onCopy={onCopy} />
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
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      onCopy?.()
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing to fall back to.
    }
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={handleClick}
        title={`Копіювати посилання — ${label}`}
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
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing to fall back to.
    }
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
        {CHANNELS.map(({ key, label, icon: Icon }) => (
          <div
            key={key}
            style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.625rem', borderRadius: 8, background: 'var(--bg-subtle)' }}
          >
            <Icon size={16} />
            <span style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', minWidth: 96 }}>{label}</span>
            <code style={{ flex: 1, fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {urls[key]}
            </code>
            <CopyTextButton text={urls[key]} />
          </div>
        ))}
      </div>
    </div>
  )
}
