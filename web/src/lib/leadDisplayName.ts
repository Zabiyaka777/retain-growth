export interface LeadNameFields {
  username: string | null
  first_name?: string | null
  last_name?: string | null
  external_id: string
}

/**
 * Shared priority order for showing a lead's name across Chats/CRM:
 * @username, then Telegram's first/last name, then the raw external_id
 * (channel user id) as a last resort — that raw id is otherwise only shown
 * in LeadProfile's "Системна інформація" as an explicitly-labeled technical
 * field, never as the lead's display name.
 */
export function leadDisplayName(lead: LeadNameFields | null | undefined): string {
  if (!lead) return 'Без імені'
  if (lead.username) return `@${lead.username}`
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
  if (fullName) return fullName
  return lead.external_id
}
