export interface LeadNameFields {
  username: string | null
  first_name?: string | null
  last_name?: string | null
  external_id: string
}

/**
 * Shared priority order for showing a lead's name across Chats, CRM and the
 * lead profile: the name from their Telegram profile (first + last) first —
 * that's how the lead introduces themselves — then @username, then the raw
 * external_id (channel user id) as a last resort. That raw id is otherwise
 * only shown in LeadProfile's "Системна інформація" as an explicitly-labeled
 * technical field.
 */
export function leadDisplayName(lead: LeadNameFields | null | undefined): string {
  if (!lead) return 'Без імені'
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
  if (fullName) return fullName
  if (lead.username) return `@${lead.username}`
  return lead.external_id
}

/** The letter shown in the avatar circle when there's no photo. */
export function leadInitial(lead: LeadNameFields | null | undefined): string {
  return leadDisplayName(lead).replace(/^@/, '').slice(0, 1).toUpperCase()
}
