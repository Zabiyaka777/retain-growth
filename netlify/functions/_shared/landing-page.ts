// Shared shape of a landing page as the public /lp page and the dashboard
// editor both understand it. Deliberately narrow — five fixed templates,
// three themes, one flat config — this is not a page builder.

export const LANDING_TEMPLATES = ["minimal", "problem_solution", "social_proof", "hr_vacancy", "product"] as const;
export type LandingTemplateKey = (typeof LANDING_TEMPLATES)[number];

export const LANDING_THEMES = ["white", "dark", "rg"] as const;
export type LandingTheme = (typeof LANDING_THEMES)[number];

export const CTA_CHANNELS = ["telegram", "whatsapp", "fbm"] as const;
export type CtaChannel = (typeof CTA_CHANNELS)[number];

// 'funnel' keeps the messenger flow: the button goes back through /r/ so
// redirect.ts can reuse the same click_id and attribution survives.
// 'link' is a plain outbound <a href> with no click_id and no messenger — a
// secondary "read more" destination. Both kinds can sit on one page.
export type CtaType = "funnel" | "link";

export interface LandingCta {
  channel: CtaChannel;
  label: string;
  enabled: boolean;
  type: CtaType;
  url: string;
  /* '' = the channel's own brand colour (or the page accent for a link) */
  color: string;
  /* second line under the label; '' = the template's default for the channel */
  sub: string;
}

export const IMAGE_ASPECTS = ["square", "portrait"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];
export const COUNTDOWN_MODES = ["off", "deadline", "cycle"] as const;
export type CountdownMode = (typeof COUNTDOWN_MODES)[number];

export interface LandingAdvantage {
  title: string;
  text: string;
}

export interface LandingConfig {
  theme: LandingTheme;
  headline: string;
  subheadline: string;
  image_url: string;
  image_aspect: ImageAspect;
  /* '' = the theme's own ink/muted colour */
  headline_color: string;
  subheadline_color: string;
  bullets: string[];
  accent_color: string;
  ctas: LandingCta[];
  urgency_text: string;
  show_urgency: boolean;
  /* problem_solution only */
  advantages: LandingAdvantage[];
  /* product only */
  price_highlight: string;
  /* product only: countdown under the price */
  countdown_mode: CountdownMode;
  countdown_deadline_at: string;
  countdown_cycle_hours: number;
  /* footer */
  privacy_url: string;
  privacy_label: string;
  /* Every other visible string on the page. '' = the template's default
     wording, so these stay translatable/editable without a schema per template. */
  texts: LandingTexts;
  /* technical — all optional, none of it gates publishing */
  seo_title: string;
  seo_description: string;
  head_code: string;
  body_code: string;
  fb_pixel_id: string;
  tiktok_pixel_id: string;
  google_tag_id: string;
}

// Keys of the fixed, non-headline copy each template renders (eyebrows,
// section titles, the footer note, …). Defaults live in the client
// (LandingTemplates.tsx TEXT_DEFAULTS) because some differ per template.
export const TEXT_KEYS = [
  "footer_note",
  "advantages_title",
  "ps_eyebrow",
  "ps_bridge",
  "stat_label",
  "hr_chip",
  "hr_section_title",
  "orb_title",
  "countdown_label",
] as const;
export type TextKey = (typeof TEXT_KEYS)[number];
export type LandingTexts = Record<TextKey, string>;

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$/;

// Slugs are global (UNIQUE(slug)) and read as a public address, so words that
// name the platform itself, or match a route the app already serves, can't be
// claimed by a tenant. Two groups: the agreed infrastructure words, and every
// path segment in web/src/App.tsx + netlify.toml (/login, /lp, /r, /dashboard/…,
// /admin/…). The web form keeps a copy in web/src/lib/reservedSlugs.ts — keep
// both in sync; this one is what actually enforces it.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "login", "app", "www", "dashboard", "static", "assets", "cdn",
  "mail", "support", "help", "blog", "docs", "status",
  // routes in the app
  "r", "lp", "chats", "crm", "funnels", "funnel-builder", "elements", "leadgentools",
  "landings", "new", "templates", "analytics", "ai", "settings", "profile",
  "integrations", "organizations", "security",
]);
export const RESERVED_SLUG_ERROR = "Ця адреса зарезервована системою — оберіть іншу";
export const TAKEN_SLUG_ERROR = "Ця адреса вже зайнята — оберіть іншу";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
// Pixel/tag ids are interpolated straight into the analytics snippets the
// public page injects, so they must never carry anything script-shaped.
export const PIXEL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_BULLETS = 8;
const MAX_ADVANTAGES = 6;
const MAX_CODE = 8000;
const MAX_CYCLE_HOURS = 24 * 7;

const DEFAULT_CTA_LABELS: Record<CtaChannel, string> = {
  telegram: "Написати в Telegram",
  whatsapp: "Написати в WhatsApp",
  fbm: "Написати в Messenger",
};

// Sanitizes an untrusted config object into exactly the fields the templates
// render. Anything else is dropped; strings are length-capped so a runaway
// paste can't bloat the row. image_url must be an absolute http(s) URL —
// javascript:/data: would otherwise land in an <img src> on a public page,
// and privacy_url the same, since it becomes an <a href>.
// One CTA per channel, always all three present (disabled ones carry their
// label so toggling back on restores the text). A legacy single `cta_label`
// from the first version becomes the Telegram CTA.
export function normalizeLandingConfig(raw: unknown): LandingConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const httpUrl = (v: unknown) => {
    const u = str(v, 2048);
    return /^https?:\/\//i.test(u) ? u : "";
  };
  const pixel = (v: unknown) => {
    const p = str(v, 40);
    return PIXEL_ID_RE.test(p) ? p : "";
  };

  const bullets = Array.isArray(src.bullets)
    ? src.bullets.map((b) => str(b, 240)).filter(Boolean).slice(0, MAX_BULLETS)
    : [];
  const advantages = Array.isArray(src.advantages)
    ? (src.advantages as Record<string, unknown>[])
        .map((a) => ({ title: str(a?.title, 80), text: str(a?.text, 300) }))
        .filter((a) => a.title || a.text)
        .slice(0, MAX_ADVANTAGES)
    : [];
  const hex = (v: unknown) => {
    const h = str(v, 7);
    return HEX_RE.test(h) ? h.toLowerCase() : "";
  };
  const accent = str(src.accent_color, 7);
  const theme = LANDING_THEMES.includes(src.theme as LandingTheme) ? (src.theme as LandingTheme) : "rg";

  const rawCtas = Array.isArray(src.ctas) ? (src.ctas as Record<string, unknown>[]) : [];
  const legacyLabel = str(src.cta_label, 60);
  const ctas: LandingCta[] = CTA_CHANNELS.map((channel) => {
    const found = rawCtas.find((c) => c && c.channel === channel);
    if (found) {
      return {
        channel,
        label: str(found.label, 60) || DEFAULT_CTA_LABELS[channel],
        enabled: found.enabled === true,
        type: found.type === "link" ? "link" : "funnel",
        url: httpUrl(found.url),
        color: hex(found.color),
        sub: str(found.sub, 80),
      };
    }
    if (channel === "telegram" && rawCtas.length === 0) {
      return { channel, label: legacyLabel || DEFAULT_CTA_LABELS[channel], enabled: true, type: "funnel", url: "", color: "", sub: "" };
    }
    return { channel, label: DEFAULT_CTA_LABELS[channel], enabled: false, type: "funnel", url: "", color: "", sub: "" };
  });

  const rawTexts = (src.texts && typeof src.texts === "object" ? src.texts : {}) as Record<string, unknown>;
  const texts = Object.fromEntries(TEXT_KEYS.map((k) => [k, str(rawTexts[k], 120)])) as LandingTexts;

  const deadlineMs = typeof src.countdown_deadline_at === "string" ? Date.parse(src.countdown_deadline_at) : NaN;
  const cycleHours = Math.round(Number(src.countdown_cycle_hours));

  return {
    theme,
    headline: str(src.headline, 160),
    subheadline: str(src.subheadline, 400),
    image_url: httpUrl(src.image_url),
    image_aspect: IMAGE_ASPECTS.includes(src.image_aspect as ImageAspect) ? (src.image_aspect as ImageAspect) : "square",
    headline_color: hex(src.headline_color),
    subheadline_color: hex(src.subheadline_color),
    bullets,
    accent_color: HEX_RE.test(accent) ? accent.toLowerCase() : "#ffc061",
    ctas,
    urgency_text: str(src.urgency_text, 200),
    show_urgency: src.show_urgency === true,
    advantages,
    price_highlight: str(src.price_highlight, 60),
    countdown_mode: COUNTDOWN_MODES.includes(src.countdown_mode as CountdownMode) ? (src.countdown_mode as CountdownMode) : "off",
    countdown_deadline_at: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : "",
    countdown_cycle_hours: cycleHours >= 1 && cycleHours <= MAX_CYCLE_HOURS ? cycleHours : 24,
    privacy_url: httpUrl(src.privacy_url),
    privacy_label: str(src.privacy_label, 60) || "Політика конфіденційності",
    texts,
    seo_title: str(src.seo_title, 120),
    seo_description: str(src.seo_description, 300),
    head_code: str(src.head_code, MAX_CODE),
    body_code: str(src.body_code, MAX_CODE),
    fb_pixel_id: pixel(src.fb_pixel_id),
    tiktok_pixel_id: pixel(src.tiktok_pixel_id),
    google_tag_id: pixel(src.google_tag_id),
  };
}
