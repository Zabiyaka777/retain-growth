import { useState } from 'react'

/**
 * The round avatar used in the thread list, the chat header, the lead profile
 * and CRM: the lead's Telegram photo when there is one, otherwise the same
 * initial-in-a-circle as before. A photo that fails to load (deleted, network)
 * quietly falls back to the initial too.
 */
export default function LeadAvatar({ url, initial, className }: { url?: string | null; initial: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const showImg = !!url && failed !== url
  return (
    <span className={`thread-avatar${showImg ? ' has-photo' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {showImg ? <img src={url!} alt="" decoding="async" onError={() => setFailed(url!)} /> : initial}
    </span>
  )
}
