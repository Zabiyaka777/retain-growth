import { useState } from 'react'
import { IconCheckCircle, IconDuplicate } from './icons'

// Clipboard write that survives the places navigator.clipboard is denied
// (permissions policy, embedded browsers, older Safari): falls back to the
// legacy selection copy, which still works inside a click handler.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

// "Скопіювати" button with a transient "Скопійовано". compact = icon only
// (cards, tight rows); the label then lives in title/aria-label.
export function CopyValue({ text, label = 'Скопіювати', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!(await copyText(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  if (compact) {
    return (
      <button
        type="button"
        className={`copy-icon-btn${copied ? ' is-copied' : ''}`}
        onClick={handleCopy}
        title={copied ? 'Скопійовано' : `${label}: ${text}`}
        aria-label={copied ? 'Скопійовано' : label}
      >
        {copied ? <IconCheckCircle size={13} /> : <IconDuplicate size={13} />}
      </button>
    )
  }
  return (
    <button type="button" className="btn btn-ghost lpe-dns-copy" onClick={handleCopy}>
      {copied ? <IconCheckCircle size={13} /> : <IconDuplicate size={13} />}
      {copied ? 'Скопійовано' : label}
    </button>
  )
}
