import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export interface AvatarLead {
  id: string
  /** Only Telegram has profile photos to fetch; others keep the initial. */
  channel_type?: string | null
  avatar_url?: string | null
  avatar_checked_at?: string | null
}

// Same TTL as telegram-avatar.ts — past it, the cached answer is refreshed.
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ROUNDS = 5

// Shared across every list/header/profile on the page for this browser
// session, so the same lead is never requested twice (Chats' list and header
// and the profile drawer all show the same person). Browser memory only — the
// source of truth is leads.avatar_url.
const known = new Map<string, string | null>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()

function isStale(lead: AvatarLead): boolean {
  if (lead.channel_type && lead.channel_type !== 'telegram') return false
  if (known.has(lead.id) || inFlight.has(lead.id)) return false
  const checked = lead.avatar_checked_at ? Date.parse(lead.avatar_checked_at) : NaN
  return !Number.isFinite(checked) || Date.now() - checked >= TTL_MS
}

async function refresh(ids: string[]) {
  ids.forEach((id) => inFlight.add(id))
  let todo = ids
  try {
    for (let round = 0; round < MAX_ROUNDS && todo.length > 0; round++) {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) return
      const res = await fetch('/.netlify/functions/telegram-avatar', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ leadIds: todo }),
      })
      if (!res.ok) return
      const body = (await res.json()) as { avatars?: Record<string, string | null>; pending?: string[] }
      for (const [id, url] of Object.entries(body.avatars ?? {})) known.set(id, url)
      listeners.forEach((l) => l())
      todo = body.pending ?? []
    }
  } catch {
    /* an avatar is decoration — the initial stays */
  } finally {
    ids.forEach((id) => inFlight.delete(id))
  }
}

/**
 * Profile-photo URL per lead id. Reads avatar_url as the caller's own query
 * already returned it, and for Telegram leads whose cached answer is missing
 * or older than a week asks telegram-avatar.ts once (batched, debounced) to
 * refresh it. Anything without a photo maps to null → the initial is shown.
 */
export function useLeadAvatars(leads: AvatarLead[]): Record<string, string | null> {
  const [, bump] = useState(0)

  useEffect(() => {
    const onUpdate = () => bump((n) => n + 1)
    listeners.add(onUpdate)
    return () => {
      listeners.delete(onUpdate)
    }
  }, [])

  const staleKey = leads
    .filter(isStale)
    .map((l) => l.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!staleKey) return
    const t = window.setTimeout(() => void refresh(staleKey.split(',')), 300)
    return () => window.clearTimeout(t)
  }, [staleKey])

  const out: Record<string, string | null> = {}
  for (const lead of leads) out[lead.id] = known.has(lead.id) ? (known.get(lead.id) ?? null) : (lead.avatar_url ?? null)
  return out
}
