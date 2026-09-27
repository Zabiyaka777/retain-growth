import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { getNetlifyToken, getSite, getSiteId, setDomainAliases } from "./_shared/netlify-api";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const UNIQUE_VIOLATION = "23505";

// Lowercase hostname, at least one dot, letters/digits/hyphens per label — no
// scheme, no path, no port. Deliberately simple: this only ever feeds into a
// Netlify API call and a DNS instruction, never into HTML/SQL directly.
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

// Our own infrastructure — accepting one of these as a tenant's "custom
// domain" would either be nonsense or let one tenant hijack traffic meant
// for the platform itself.
const RESERVED_SUFFIXES = [".netlify.app", ".retain-growth.ai", "retain-growth.ai", "localhost"];

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Attaches (or removes) a custom domain on one landing page: validates it,
// registers/unregisters it as a domain alias on this Netlify site via the
// API, and records it on the row. DNS/SSL verification is a separate step
// (check-landing-domain.ts) — this call only ever leaves the row in
// 'pending', even on a clean success, since Netlify adding the alias says
// nothing about whether the tenant has actually pointed their DNS at us yet.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let landingPageId = "";
  let customDomain: string | null = null; // null = remove
  try {
    const body = JSON.parse(event.body || "{}");
    landingPageId = typeof body.landingPageId === "string" ? body.landingPageId : "";
    customDomain = typeof body.customDomain === "string" && body.customDomain.trim() ? body.customDomain.trim().toLowerCase() : null;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!landingPageId) return jsonResponse(400, { error: "landingPageId обов'язковий" });

  if (customDomain) {
    if (!DOMAIN_RE.test(customDomain)) return jsonResponse(400, { error: "Невалідний домен — вкажіть, напр., promo.вашдомен.com" });
    if (RESERVED_SUFFIXES.some((s) => customDomain === s || customDomain!.endsWith(s))) {
      return jsonResponse(400, { error: "Цей домен зарезервовано системою" });
    }
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  const { data: landing, error: landingError } = await supabase
    .from("landing_pages")
    .select("id, custom_domain")
    .eq("id", landingPageId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (landingError || !landing) return jsonResponse(404, { error: "Лендінг не знайдено" });

  const previousDomain = landing.custom_domain as string | null;
  if (!customDomain && !previousDomain) return jsonResponse(200, { ok: true, customDomain: null, status: null });

  const siteId = getSiteId();
  if (!siteId) return jsonResponse(500, { error: "SITE_ID недоступний у середовищі функції" });

  const token = await getNetlifyToken(supabase);
  if (!token) {
    return jsonResponse(409, { error: "Netlify API ще не налаштовано — зверніться до адміністратора платформи" });
  }

  const site = await getSite(token, siteId);
  if (!site) return jsonResponse(502, { error: "Не вдалося зв'язатися з Netlify API" });

  let aliases = site.domain_aliases ?? [];
  if (previousDomain) aliases = aliases.filter((a) => a !== previousDomain);
  if (customDomain && !aliases.includes(customDomain)) aliases = [...aliases, customDomain];

  const patched = await setDomainAliases(token, siteId, aliases);
  if (!patched) return jsonResponse(502, { error: "Не вдалося оновити домени в Netlify" });

  const { error: updateError } = await supabase
    .from("landing_pages")
    .update({ custom_domain: customDomain, custom_domain_status: "pending" })
    .eq("id", landingPageId)
    .eq("org_id", orgId);

  if (updateError) {
    // The Netlify-side alias is already set/cleared at this point; the row
    // just didn't record it. Not rolled back — a mismatch here is safer
    // surfaced (retry the save) than silently reverting Netlify's state
    // out from under a change that may have already reached the tenant.
    if (updateError.code === UNIQUE_VIOLATION) return jsonResponse(409, { error: "Цей домен уже прив'язано до іншого лендінга" });
    console.error("save-landing-domain: landing_pages update failed", updateError);
    return jsonResponse(500, { error: "Домен оновлено в Netlify, але не вдалося зберегти в базі. Спробуйте ще раз" });
  }

  return jsonResponse(200, { ok: true, customDomain, status: customDomain ? "pending" : null, dnsTarget: site.default_domain });
};
