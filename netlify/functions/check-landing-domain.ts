import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import dns from "node:dns/promises";
import { getNetlifyToken, getSite, getSiteId, getSslState, provisionSsl } from "./_shared/netlify-api";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// "Перевірити" — the DNS half is a resolver lookup we do ourselves (a CNAME
// to <site>.netlify.app, or an A/ALIAS record for an apex domain resolving to
// one of Netlify's load-balancer addresses); the SSL half asks Netlify
// directly. Both are best-effort reads — a lookup failure just means "not
// verified yet", never an error response, since the whole point of this
// button is "the tenant's DNS might not have propagated yet, check again".
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let landingPageId = "";
  try {
    const body = JSON.parse(event.body || "{}");
    landingPageId = typeof body.landingPageId === "string" ? body.landingPageId : "";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!landingPageId) return jsonResponse(400, { error: "landingPageId обов'язковий" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  const { data: landing, error: landingError } = await supabase
    .from("landing_pages")
    .select("id, custom_domain, custom_domain_status")
    .eq("id", landingPageId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (landingError || !landing) return jsonResponse(404, { error: "Лендінг не знайдено" });

  const customDomain = landing.custom_domain as string | null;
  if (!customDomain) return jsonResponse(400, { error: "Для цього лендінга не задано власний домен" });

  const siteId = getSiteId();
  const token = siteId ? await getNetlifyToken(supabase) : null;
  const site = token && siteId ? await getSite(token, siteId) : null;

  let dnsResolved = false;
  try {
    const cnames = await dns.resolveCname(customDomain).catch(() => [] as string[]);
    if (site && cnames.some((c) => c.replace(/\.$/, "") === site.default_domain)) {
      dnsResolved = true;
    } else {
      // Apex domains can't carry a CNAME — check the A record instead, against
      // every address Netlify's own site record resolves to right now rather
      // than a hardcoded IP that could change on their end.
      const [domainAddrs, siteAddrs] = await Promise.all([
        dns.resolve4(customDomain).catch(() => [] as string[]),
        site ? dns.resolve4(site.default_domain).catch(() => [] as string[]) : Promise.resolve([] as string[]),
      ]);
      dnsResolved = domainAddrs.length > 0 && domainAddrs.some((a) => siteAddrs.includes(a));
    }
  } catch (err) {
    console.error("check-landing-domain: DNS lookup failed", err);
  }

  let sslIssued = false;
  if (token && siteId) {
    if (dnsResolved) {
      // Only worth nudging Netlify to (re)provision once DNS actually points
      // here — asking earlier just fails the same way every time.
      await provisionSsl(token, siteId);
    }
    const ssl = await getSslState(token, siteId);
    sslIssued = !!ssl && (ssl.state === "issued" || (Array.isArray(ssl.domains) && ssl.domains.includes(customDomain)));
  }

  const verified = dnsResolved && sslIssued;
  if (verified !== (landing.custom_domain_status === "verified")) {
    const { error } = await supabase
      .from("landing_pages")
      .update({ custom_domain_status: verified ? "verified" : "pending" })
      .eq("id", landingPageId)
      .eq("org_id", orgId);
    if (error) console.error("check-landing-domain: status update failed", error);
  }

  // dnsTarget too, not just from save-landing-domain: the editor only learns
  // the CNAME value from one of these two calls, and after a reload the
  // tenant never re-binds — they come back to press "Перевірити".
  return jsonResponse(200, {
    ok: true,
    dnsResolved,
    sslIssued,
    status: verified ? "verified" : "pending",
    dnsTarget: site?.default_domain ?? null,
  });
};
