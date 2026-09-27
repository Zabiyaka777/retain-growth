import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dns from "node:dns/promises";
import tls from "node:tls";
import { getNetlifyToken, getSite, getSiteId, provisionSsl, setDomainAliases } from "./netlify-api";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

// Custom domains for anything a tenant can point a hostname at — landing
// pages (served in place by edge-functions/custom-domain.ts) and lead-gen
// links (302'd to /r/:ref_token by the same edge function). Both register the
// hostname as a domain alias of this Netlify site and verify DNS/SSL the same
// way; only the table, the id field in the request body and the wording
// differ, so each save-*-domain.ts / check-*-domain.ts is a one-line wrapper
// around the handlers built here.

export type DomainEntity = "landing" | "link";

interface EntityConfig {
  table: "landing_pages" | "lead_gen_links";
  bodyKey: "landingPageId" | "linkId";
  notFound: string;
  taken: string;
}

const ENTITIES: Record<DomainEntity, EntityConfig> = {
  landing: {
    table: "landing_pages",
    bodyKey: "landingPageId",
    notFound: "Лендінг не знайдено",
    taken: "Цей домен уже прив'язано до іншого лендінга чи посилання",
  },
  link: {
    table: "lead_gen_links",
    bodyKey: "linkId",
    notFound: "Посилання не знайдено",
    taken: "Цей домен уже прив'язано до іншого посилання чи лендінга",
  },
};

const UNIQUE_VIOLATION = "23505";

// Lowercase hostname, at least one dot, letters/digits/hyphens per label — no
// scheme, no path, no port. Deliberately simple: this only ever feeds into a
// Netlify API call and a DNS instruction, never into HTML/SQL directly.
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

// Our own infrastructure — accepting one of these as a tenant's "custom
// domain" would either be nonsense or let one tenant hijack traffic meant
// for the platform itself.
const RESERVED_SUFFIXES = [".netlify.app", ".retain-growth.ai", "retain-growth.ai", "localhost"];

// Ground truth for "HTTPS works": a real TLS handshake to the domain with
// normal certificate validation — exactly what the visitor's browser does.
// Netlify's own /ssl state can't answer this: it reads "issued" for the
// site's existing certificate long before (or without) the new alias being
// on it, which is how a domain once showed "Підключено" while Chrome
// rejected it.
function tlsValidFor(domain: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: domain, port: 443, servername: domain, timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("secureConnect", () => done(socket.authorized));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

type Authed = { supabase: SupabaseClient; orgId: string } | { error: ReturnType<typeof jsonResponse> };

function bearer(event: Parameters<Handler>[0]): string | null {
  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

async function authenticate(event: Parameters<Handler>[0]): Promise<Authed> {
  const accessToken = bearer(event);
  if (!accessToken) return { error: jsonResponse(401, { error: "Відсутній заголовок авторизації" }) };

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return { error: jsonResponse(401, { error: "Недійсна сесія" }) };

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return { error: jsonResponse(403, { error: "Організацію не знайдено для цього користувача" }) };
  return { supabase, orgId: profile.org_id as string };
}

// Any OTHER row, in either table, already holding this hostname. The DB
// enforces the same thing (per-table UNIQUE + a cross-table trigger); this
// just catches it before the Netlify alias is touched, so a rejected save
// never leaves an alias behind.
async function domainTaken(supabase: SupabaseClient, domain: string, table: EntityConfig["table"], id: string) {
  const [landings, links] = await Promise.all([
    supabase.from("landing_pages").select("id").eq("custom_domain", domain).limit(1),
    supabase.from("lead_gen_links").select("id").eq("custom_domain", domain).limit(1),
  ]);
  const other = (rows: { id: string }[] | null, t: string) => (rows ?? []).some((r) => !(t === table && r.id === id));
  return other(landings.data, "landing_pages") || other(links.data, "lead_gen_links");
}

// Removes the Netlify alias of every custom domain whose landing/link row is
// gone — the custom_domain_removals queue is filled by a DB trigger on
// delete (including cascades from funnels/organizations). Best-effort and
// idempotent: without a token or on a Netlify error the queue is simply left
// for the next run; a domain that has since been re-attached to some other
// row is dropped from the queue but its alias kept.
export async function drainDomainRemovals(supabase: SupabaseClient): Promise<{ removed: string[]; kept: string[] } | null> {
  const { data: queued, error } = await supabase.from("custom_domain_removals").select("domain");
  if (error) {
    console.error("drainDomainRemovals: queue read failed", error);
    return null;
  }
  const domains = (queued ?? []).map((r) => r.domain as string);
  if (domains.length === 0) return { removed: [], kept: [] };

  const [landings, links] = await Promise.all([
    supabase.from("landing_pages").select("custom_domain").in("custom_domain", domains),
    supabase.from("lead_gen_links").select("custom_domain").in("custom_domain", domains),
  ]);
  if (landings.error || links.error) {
    console.error("drainDomainRemovals: in-use lookup failed", landings.error ?? links.error);
    return null;
  }
  const inUse = new Set([...(landings.data ?? []), ...(links.data ?? [])].map((r) => r.custom_domain as string));
  const kept = domains.filter((d) => inUse.has(d));
  const toRemove = domains.filter((d) => !inUse.has(d));

  if (toRemove.length > 0) {
    const siteId = getSiteId();
    const token = siteId ? await getNetlifyToken(supabase) : null;
    if (!siteId || !token) return null;
    const site = await getSite(token, siteId);
    if (!site) return null;
    const aliases = site.domain_aliases ?? [];
    const next = aliases.filter((a) => !toRemove.includes(a));
    if (next.length !== aliases.length && !(await setDomainAliases(token, siteId, next))) return null;
  }

  const { error: clearError } = await supabase.from("custom_domain_removals").delete().in("domain", domains);
  if (clearError) console.error("drainDomainRemovals: queue clear failed", clearError);
  return { removed: toRemove, kept };
}

// Attaches (or removes, customDomain: null) a custom domain on one row:
// validates it, registers/unregisters it as a domain alias on this Netlify
// site via the API, and records it on the row. DNS/SSL verification is the
// separate check handler below — this one only ever leaves the row in
// 'pending', even on a clean success, since Netlify adding the alias says
// nothing about whether the tenant has actually pointed their DNS at us yet.
export function makeSaveDomainHandler(entity: DomainEntity): Handler {
  const cfg = ENTITIES[entity];
  const logTag = `save-${entity}-domain`;

  return async (event) => {
    if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });
    // No session → 401 before anything else looks at the body.
    if (!bearer(event)) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

    let id = "";
    let customDomain: string | null = null; // null = remove
    try {
      const body = JSON.parse(event.body || "{}");
      id = typeof body[cfg.bodyKey] === "string" ? body[cfg.bodyKey] : "";
      customDomain = typeof body.customDomain === "string" && body.customDomain.trim() ? body.customDomain.trim().toLowerCase() : null;
    } catch {
      return jsonResponse(400, { error: "Невалідне тіло запиту" });
    }
    if (!id) return jsonResponse(400, { error: `${cfg.bodyKey} обов'язковий` });

    if (customDomain) {
      if (!DOMAIN_RE.test(customDomain)) return jsonResponse(400, { error: "Невалідний домен — вкажіть, напр., promo.вашдомен.com" });
      if (RESERVED_SUFFIXES.some((s) => customDomain === s || customDomain!.endsWith(s))) {
        return jsonResponse(400, { error: "Цей домен зарезервовано системою" });
      }
    }

    const auth = await authenticate(event);
    if ("error" in auth) return auth.error;
    const { supabase, orgId } = auth;

    const { data: row, error: rowError } = await supabase
      .from(cfg.table)
      .select("id, custom_domain")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (rowError || !row) return jsonResponse(404, { error: cfg.notFound });

    const previousDomain = row.custom_domain as string | null;
    if (!customDomain && !previousDomain) return jsonResponse(200, { ok: true, customDomain: null, status: null });

    if (customDomain && (await domainTaken(supabase, customDomain, cfg.table, id))) {
      return jsonResponse(409, { error: cfg.taken });
    }

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
      .from(cfg.table)
      .update({ custom_domain: customDomain, custom_domain_status: "pending" })
      .eq("id", id)
      .eq("org_id", orgId);

    if (updateError) {
      // The Netlify-side alias is already set/cleared at this point; the row
      // just didn't record it. Not rolled back — a mismatch here is safer
      // surfaced (retry the save) than silently reverting Netlify's state
      // out from under a change that may have already reached the tenant.
      if (updateError.code === UNIQUE_VIOLATION) return jsonResponse(409, { error: cfg.taken });
      console.error(`${logTag}: ${cfg.table} update failed`, updateError);
      return jsonResponse(500, { error: "Домен оновлено в Netlify, але не вдалося зберегти в базі. Спробуйте ще раз" });
    }

    return jsonResponse(200, { ok: true, customDomain, status: customDomain ? "pending" : null, dnsTarget: site.default_domain });
  };
}

// "Перевірити" — the DNS half is a resolver lookup we do ourselves (a CNAME
// to <site>.netlify.app, or an A/ALIAS record for an apex domain resolving to
// one of Netlify's load-balancer addresses); the SSL half asks Netlify
// directly. Both are best-effort reads — a lookup failure just means "not
// verified yet", never an error response, since the whole point of this
// button is "the tenant's DNS might not have propagated yet, check again".
export function makeCheckDomainHandler(entity: DomainEntity): Handler {
  const cfg = ENTITIES[entity];
  const logTag = `check-${entity}-domain`;

  return async (event) => {
    if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });
    // No session → 401 before anything else looks at the body.
    if (!bearer(event)) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

    let id = "";
    try {
      const body = JSON.parse(event.body || "{}");
      id = typeof body[cfg.bodyKey] === "string" ? body[cfg.bodyKey] : "";
    } catch {
      return jsonResponse(400, { error: "Невалідне тіло запиту" });
    }

    if (!id) return jsonResponse(400, { error: `${cfg.bodyKey} обов'язковий` });

    const auth = await authenticate(event);
    if ("error" in auth) return auth.error;
    const { supabase, orgId } = auth;

    const { data: row, error: rowError } = await supabase
      .from(cfg.table)
      .select("id, custom_domain, custom_domain_status")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (rowError || !row) return jsonResponse(404, { error: cfg.notFound });

    const customDomain = row.custom_domain as string | null;
    if (!customDomain) return jsonResponse(400, { error: "Власний домен не задано" });

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
      console.error(`${logTag}: DNS lookup failed`, err);
    }

    // Only worth checking (and nudging Netlify to reissue the certificate)
    // once DNS actually points here — earlier, both fail the same way every
    // time. Reissue only while the handshake still fails: it's a Let's
    // Encrypt order each time, and they're rate-limited.
    const sslIssued = dnsResolved ? await tlsValidFor(customDomain) : false;
    if (dnsResolved && !sslIssued && token && siteId) {
      await provisionSsl(token, siteId);
    }

    const verified = dnsResolved && sslIssued;
    if (verified !== (row.custom_domain_status === "verified")) {
      const { error } = await supabase
        .from(cfg.table)
        .update({ custom_domain_status: verified ? "verified" : "pending" })
        .eq("id", id)
        .eq("org_id", orgId);
      if (error) console.error(`${logTag}: status update failed`, error);
    }

    // dnsTarget too, not just from the save handler: the editor only learns
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
}
