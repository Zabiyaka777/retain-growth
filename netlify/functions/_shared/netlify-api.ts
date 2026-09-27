import type { SupabaseClient } from "@supabase/supabase-js";

// Talks to Netlify's own API (https://api.netlify.com/api/v1) to manage this
// site's domain aliases — the mechanism behind per-tenant custom domains on
// landing pages. One platform-level credential (not per-org), stored in
// Vault like every other secret in this app, referenced by
// platform_settings.key = 'netlify_api_token'.

const NETLIFY_API = "https://api.netlify.com/api/v1";

export interface NetlifySite {
  id: string;
  name: string;
  default_domain: string;
  custom_domain: string | null;
  domain_aliases: string[];
}

/** Reads the platform's Netlify API token out of Vault. null if never configured. */
export async function getNetlifyToken(supabase: SupabaseClient): Promise<string | null> {
  const { data: setting, error: settingError } = await supabase
    .from("platform_settings")
    .select("secret_id")
    .eq("key", "netlify_api_token")
    .maybeSingle();
  if (settingError) {
    console.error("netlify-api: platform_settings lookup failed", settingError);
    return null;
  }
  if (!setting) return null;

  const { data: token, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: setting.secret_id,
  });
  if (tokenError || !token) {
    console.error("netlify-api: vault_read_secret failed", tokenError);
    return null;
  }
  return token as string;
}

// Netlify's site id is injected into every function's runtime automatically —
// never configured by hand, so there's nothing to get out of sync with the
// site this code actually runs on.
export function getSiteId(): string | null {
  return process.env.SITE_ID ?? null;
}

export async function getSite(token: string, siteId: string): Promise<NetlifySite | null> {
  const res = await fetch(`${NETLIFY_API}/sites/${siteId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("netlify-api: getSite failed", res.status, await res.text().catch(() => ""));
    return null;
  }
  return (await res.json()) as NetlifySite;
}

// Netlify's updateSite endpoint REPLACES the whole domain_aliases array —
// there's no "append one" call — so every caller must read the current list
// first (getSite) and pass the complete list back.
export async function setDomainAliases(token: string, siteId: string, aliases: string[]): Promise<boolean> {
  const res = await fetch(`${NETLIFY_API}/sites/${siteId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ domain_aliases: aliases }),
  });
  if (!res.ok) {
    console.error("netlify-api: setDomainAliases failed", res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

/**
 * Asks Netlify to (re)issue the site's Let's Encrypt certificate so it covers
 * the current domain aliases. A site that already has a certificate (ours
 * always does — app.retain-growth.ai) must go through /ssl/renew: plain
 * POST /ssl on such a site is the *custom*-certificate upload and answers 422
 * "certificate parameter is required when updating an existing certificate".
 * Plain /ssl is kept only as the fallback for a site with no certificate yet.
 * Issuance itself is asynchronous — a 200 here means "started", not "done".
 */
export async function provisionSsl(token: string, siteId: string): Promise<boolean> {
  try {
    const renew = await fetch(`${NETLIFY_API}/sites/${siteId}/ssl/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (renew.ok) return true;
    const renewBody = await renew.text().catch(() => "");
    const fresh = await fetch(`${NETLIFY_API}/sites/${siteId}/ssl`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!fresh.ok) {
      console.error("netlify-api: provisionSsl failed", renew.status, renewBody, fresh.status, await fresh.text().catch(() => ""));
    }
    return fresh.ok;
  } catch (err) {
    console.error("netlify-api: provisionSsl threw", err);
    return false;
  }
}
