import type { Config, Context } from "@netlify/edge-functions";

// Runs on every request to this site. Its only job: when the Host header is
// none of ours, check whether it's a tenant's custom domain — a lead-gen
// link's (lead_gen_links.custom_domain) is just a 302 to /r/:ref_token, see
// linkRedirect below. Otherwise, whether it's a custom landing-page domain
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

const LINK_CHANNELS = new Set(["telegram", "whatsapp", "fbm"]);

async function lookup<T>(supabaseUrl: string, serviceKey: string, query: string): Promise<T | null> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/${query}`, {
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    });
    if (!res.ok) {
      console.error("custom-domain edge: lookup failed", query.split("?")[0], res.status);
      return null;
    }
    return ((await res.json()) as T[])[0] ?? null;
  } catch (err) {
    console.error("custom-domain edge: lookup threw", query.split("?")[0], err);
    return null;
  }
}

// A lead-gen link on its own domain needs no rendering at all — the link
// sends the visitor off to a messenger anyway — so the domain's root simply
// hands over to the ordinary /r/:ref_token flow (redirect.ts, unchanged:
// click logging, click_id, channel choice). Relative, so the hop stays on the
// tenant's domain; every query param (fbclid, utm_*) rides along. A bare
// domain with no ?ch= means Telegram, the one channel redirect.ts can serve
// today — otherwise the ad's plain URL would land on "missing channel".
function linkRedirect(url: URL, refToken: string): Response {
  const params = new URLSearchParams(url.search);
  if (!LINK_CHANNELS.has(params.get("ch") ?? "")) params.set("ch", "telegram");
  return new Response(null, {
    status: 302,
    headers: { location: `/r/${encodeURIComponent(refToken)}?${params}`, "cache-control": "no-store" },
  });
}

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const host = url.hostname;

  if (KNOWN_HOSTS.has(host) || host.endsWith(".netlify.app")) return context.next();
  // /r/* on a custom domain is the hop linkRedirect itself just issued —
  // redirect.ts's job from here, never re-resolved (that would loop).
  if (url.pathname.startsWith("/r/")) return context.next();

  // Links answer only at the root: /favicon.ico, /robots.txt and the like on
  // a link domain must not turn into a logged "click". Landings resolve only
  // a navigation's own document request — everything the resulting page then
  // loads (hashed JS/CSS, /.netlify/functions/*) must pass straight through.
  const isRoot = url.pathname === "/";
  const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  if (!isRoot && !wantsHtml) return context.next();

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return context.next();

  const domain = encodeURIComponent(host);
  // Landing first (it's the one that can match on any path); at the root the
  // link lookup runs alongside rather than after, so a link domain doesn't
  // pay for two round-trips in a row.
  const [landing, link] = await Promise.all([
    wantsHtml
      ? lookup<{ slug?: string }>(supabaseUrl, serviceKey, `landing_pages?select=slug&custom_domain=eq.${domain}&status=eq.published&limit=1`)
      : Promise.resolve(null),
    isRoot
      ? lookup<{ ref_token?: string }>(supabaseUrl, serviceKey, `lead_gen_links?select=ref_token&custom_domain=eq.${domain}&limit=1`)
      : Promise.resolve(null),
  ]);

  const slug = landing?.slug ?? null;
  if (!slug) {
    if (link?.ref_token) return linkRedirect(url, link.ref_token);
    // No match — an unregistered/typo'd/stale domain still pointed at us.
    // Falls through to the normal app (effectively the login screen), same as
    // any other unrecognized request; never a hard error for a visitor.
    return context.next();
  }

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
