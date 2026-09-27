import type { Config, Context } from "@netlify/edge-functions";

// Runs on every request to this site. Its only job: when the Host header is
// none of ours, check whether it's a tenant's custom landing-page domain
// (landing_pages.custom_domain, set via the editor's "Свій домен" panel and
// registered as a Netlify domain alias by save-landing-domain.ts) and, if
// so, serve the SPA's index.html with that landing's slug pre-resolved — so
// LandingPage.tsx can render it without ever seeing a /lp/:slug URL. Deciding
// which domain maps to which landing happens entirely here, at the edge —
// App.tsx's route table and LandingTemplate rendering are untouched.
//
// Deliberately NOT a redirect to /lp/:slug: the tenant's own domain should
// stay in the visitor's address bar, not bounce them onto ours.

const KNOWN_HOSTS = new Set(["app.retain-growth.ai", "retain-growth.ai", "www.retain-growth.ai", "localhost"]);

// The relaxed CSP /lp/* gets in netlify/_headers (Meta/TikTok/Google pixel
// sources) — duplicated here rather than shared, since this request lands on
// "/" as far as _headers' path matching is concerned and would otherwise get
// the strict default CSP, silently breaking every pixel script on a tenant's
// own domain. Keep in sync with netlify/_headers' /lp/* block by hand.
const LANDING_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://connect.facebook.net https://analytics.tiktok.com https://*.tiktok.com https://www.googletagmanager.com https://*.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://googleads.g.doubleclick.net https://www.googleadservices.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' https:; connect-src 'self' https://jgtykwfwxotticfxvvwd.supabase.co wss://jgtykwfwxotticfxvvwd.supabase.co https://*.facebook.com https://*.facebook.net https://*.tiktok.com https://*.tiktokw.us https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.doubleclick.net https://www.google.com https://*.run.app https://*.on.aws; frame-src https://*.facebook.com https://*.doubleclick.net https://www.googletagmanager.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const host = url.hostname;

  if (KNOWN_HOSTS.has(host) || host.endsWith(".netlify.app")) return context.next();
  // Assets, functions, the manifest, etc. — only a navigation's own document
  // request needs resolving; everything the resulting page then loads
  // (hashed JS/CSS, /.netlify/functions/*) must pass straight through.
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/html")) return context.next();

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return context.next();

  let slug: string | null = null;
  try {
    const lookup = await fetch(
      `${supabaseUrl}/rest/v1/landing_pages?select=slug&custom_domain=eq.${encodeURIComponent(host)}&status=eq.published&limit=1`,
      { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
    );
    if (lookup.ok) {
      const rows = (await lookup.json()) as { slug?: string }[];
      slug = rows[0]?.slug ?? null;
    } else {
      console.error("custom-domain edge: landing_pages lookup failed", lookup.status);
    }
  } catch (err) {
    console.error("custom-domain edge: landing_pages lookup threw", err);
  }

  // No match — an unregistered/typo'd/stale domain still pointed at us.
  // Falls through to the normal app (effectively the login screen), same as
  // any other unrecognized request; never a hard error for a visitor.
  if (!slug) return context.next();

  const res = await context.next();
  const html = await res.text();
  // JSON.stringify doubles as escaping — slug is a URL-safe value we already
  // validated (SLUG_RE) when it was saved, but this is what makes injecting
  // it into a <script> safe regardless.
  const injected = html.replace("</head>", `<script>window.__LP_SLUG__=${JSON.stringify(slug)};</script></head>`);

  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=UTF-8");
  headers.set("content-security-policy", LANDING_CSP);
  headers.delete("content-length");

  return new Response(injected, { status: res.status, headers });
};

export const config: Config = { path: "/*", excludedPath: ["/.netlify/*", "/assets/*"] };
