// Copy of RESERVED_SLUGS in netlify/functions/_shared/landing-page.ts, which
// is what save-landing-page.ts and check-landing-slug.ts enforce. Kept here
// only so the editor can say "reserved" instead of a bare "taken" — keep the
// two lists in sync.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin', 'api', 'login', 'app', 'www', 'dashboard', 'static', 'assets', 'cdn',
  'mail', 'support', 'help', 'blog', 'docs', 'status',
  // routes in the app
  'r', 'lp', 'chats', 'crm', 'funnels', 'funnel-builder', 'elements', 'leadgentools',
  'landings', 'new', 'templates', 'analytics', 'ai', 'settings', 'profile',
  'integrations', 'organizations', 'security',
])
