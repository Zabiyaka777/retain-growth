import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { logAdminAction, requirePlatformAdmin } from "./_shared/platform-admin";
import { findClickFixSigns, normalizeLandingConfig } from "./_shared/landing-page";

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

/**
 * The admin side of the ClickFix guard (see _shared/landing-page.ts).
 *
 *   { action: "list" }               → every *published* landing page, across
 *                                      all orgs, that the filter flags today
 *   { action: "unpublish", id }      → sends that page back to draft
 *
 * save-landing-page.ts stops new publications; this covers pages that were
 * already public before the filter existed (or before a rule was added).
 * Unpublishing is the whole takedown: /lp and redirect.ts only ever serve a
 * published page, so the public URL 404s and any lead-gen link using it falls
 * back to going straight to the messenger. The page and its content stay, so
 * nothing is lost if the flag was wrong — and republishing runs through the
 * same filter.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let action: "list" | "unpublish" = "list";
  let id: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    action = body.action === "unpublish" ? "unpublish" : "list";
    id = typeof body.id === "string" ? body.id : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });

  if (action === "unpublish") {
    if (!id) return jsonResponse(400, { error: "id обов'язковий" });
    const { data: page, error } = await supabase
      .from("landing_pages")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "published")
      .select("id, org_id, slug, name, config")
      .maybeSingle();
    if (error) {
      console.error("admin-landing-review: unpublish failed", error);
      return jsonResponse(500, { error: "Не вдалося зняти з публікації" });
    }
    if (!page) return jsonResponse(404, { error: "Опублікований лендінг не знайдено" });

    const signs = findClickFixSigns(normalizeLandingConfig(page.config));
    // The org's own event feed, so the owner-facing trail says why the page
    // went offline; the admin audit log records who did it.
    const { error: eventError } = await supabase.from("events").insert({
      org_id: page.org_id,
      type: "landing_unpublished_by_admin",
      level: "warn",
      payload: { landing_page_id: page.id, slug: page.slug, name: page.name, signs },
    });
    if (eventError) console.error("admin-landing-review: events insert failed", eventError);
    await logAdminAction(supabase, admin, "landing_unpublished", { landing_page_id: page.id, slug: page.slug, signs }, page.org_id as string);
    return jsonResponse(200, { ok: true });
  }

  const { data: pages, error } = await supabase
    .from("landing_pages")
    .select("id, org_id, name, slug, config, updated_at")
    .eq("status", "published")
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("admin-landing-review: list failed", error);
    return jsonResponse(500, { error: "Не вдалося прочитати лендінги" });
  }

  const flagged = (pages ?? [])
    .map((p) => ({ p, signs: findClickFixSigns(normalizeLandingConfig(p.config)) }))
    .filter((x) => x.signs.length > 0);

  const orgIds = [...new Set(flagged.map((x) => x.p.org_id as string))];
  const { data: orgs } = orgIds.length
    ? await supabase.from("organizations").select("id, name").in("id", orgIds)
    : { data: [] as { id: string; name: string }[] };
  const orgName = new Map((orgs ?? []).map((o) => [o.id as string, o.name as string]));

  await logAdminAction(supabase, admin, "landing_review_list", { scanned: pages?.length ?? 0, flagged: flagged.length });

  return jsonResponse(200, {
    scanned: pages?.length ?? 0,
    flagged: flagged.map(({ p, signs }) => ({
      id: p.id,
      orgId: p.org_id,
      orgName: orgName.get(p.org_id as string) ?? null,
      name: p.name,
      slug: p.slug,
      updatedAt: p.updated_at,
      signs,
    })),
  });
};
