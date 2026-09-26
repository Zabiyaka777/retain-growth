import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import {
  LANDING_TEMPLATES,
  RESERVED_SLUGS,
  RESERVED_SLUG_ERROR,
  SLUG_RE,
  TAKEN_SLUG_ERROR,
  findClickFixSigns,
  normalizeLandingConfig,
  type LandingTemplateKey,
} from "./_shared/landing-page";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const UNIQUE_VIOLATION = "23505";

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Create / update / delete a landing page. landing_pages is SELECT-only under
// RLS, so every write comes through here with the service role, scoped to the
// caller's org resolved from their session (see CLAUDE.md: org_id scoping).
// A landing is self-contained: it carries its own tunnel + entry point and
// routes its own visitors (landing-go.ts) — no lead-gen link is involved.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const id = typeof body.id === "string" ? body.id : undefined;
  const deleteId = body.delete === true && id ? id : undefined;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const templateKey = body.templateKey as LandingTemplateKey;
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const status = body.status === "published" ? "published" : "draft";
  // Same contract as save-leadgen-link.ts: blank means "keep what's stored"
  // (the form never shows the decrypted token back), explicit null clears it.
  const metaAccessToken =
    typeof body.metaAccessToken === "string" && body.metaAccessToken.trim() ? body.metaAccessToken.trim() : undefined;
  const clearMetaToken = body.metaAccessToken === null;
  // Where the page's messenger buttons lead. Absent from the body = leave the
  // stored choice alone; both null = clear it.
  const routingSent = "funnelId" in body || "entryNodeId" in body;
  const funnelId = typeof body.funnelId === "string" && body.funnelId ? body.funnelId : null;
  const entryNodeId = typeof body.entryNodeId === "string" && body.entryNodeId ? body.entryNodeId : null;

  if (!deleteId) {
    if (!name) return jsonResponse(400, { error: "Вкажіть назву" });
    if (!LANDING_TEMPLATES.includes(templateKey)) return jsonResponse(400, { error: "Невідомий шаблон" });
    if (!SLUG_RE.test(slug)) {
      return jsonResponse(400, { error: "Адреса: 3–60 символів, лише латинські літери в нижньому регістрі, цифри та дефіс" });
    }
    if (RESERVED_SLUGS.has(slug)) return jsonResponse(400, { error: RESERVED_SLUG_ERROR });
    if (routingSent && !!funnelId !== !!entryNodeId) {
      return jsonResponse(400, { error: "Оберіть тунель і точку входу разом" });
    }
    if (metaAccessToken && !/^[A-Za-z0-9]{40,300}$/.test(metaAccessToken)) {
      return jsonResponse(400, {
        error: "Токен доступу має бути одним рядком з латинських літер і цифр, без пробілів, переносів рядків чи іншого тексту",
      });
    }
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  if (deleteId) {
    const { data: gone } = await supabase
      .from("landing_pages")
      .select("meta_access_token_secret_id")
      .eq("id", deleteId)
      .eq("org_id", orgId)
      .maybeSingle();

    const { error } = await supabase.from("landing_pages").delete().eq("id", deleteId).eq("org_id", orgId);
    if (error) {
      console.error("save-landing-page: delete failed", error);
      return jsonResponse(500, { error: "Не вдалося видалити лендінг" });
    }
    // Only after the row is gone is the FK reference released (same lesson as
    // connect-telegram / save-leadgen-link).
    if (gone?.meta_access_token_secret_id) {
      const { error: vaultError } = await supabase.rpc("vault_delete_secret", { secret_id: gone.meta_access_token_secret_id });
      if (vaultError) console.error("save-landing-page: vault_delete_secret failed", vaultError);
    }
    return jsonResponse(200, { ok: true });
  }

  const config = normalizeLandingConfig(body.config);

  // Must be this org's funnel, and the node one of ITS entry points — a stray
  // id from another org (or a non-entry node) would misroute every lead.
  if (funnelId && entryNodeId) {
    const { data: funnel } = await supabase.from("funnels").select("id").eq("id", funnelId).eq("org_id", orgId).maybeSingle();
    if (!funnel) return jsonResponse(404, { error: "Воронку не знайдено" });
    const { data: entryNode } = await supabase
      .from("funnel_nodes")
      .select("id")
      .eq("id", entryNodeId)
      .eq("funnel_id", funnelId)
      .eq("type", "entry")
      .maybeSingle();
    if (!entryNode) return jsonResponse(404, { error: "Точку входу не знайдено в обраному тунелі" });
  }

  const hasFunnelCta = config.ctas.some((c) => c.enabled && c.type === "funnel");
  if (status === "published" && hasFunnelCta && !funnelId) {
    return jsonResponse(400, { error: "Оберіть тунель і точку входу — інакше кнопки месенджерів нікуди не ведуть" });
  }

  if (status === "published" && !config.headline) {
    return jsonResponse(400, { error: "Опублікувати можна лише лендінг із заголовком" });
  }
  if (status === "published" && !config.ctas.some((c) => c.enabled)) {
    return jsonResponse(400, { error: "Увімкніть хоча б одну кнопку, інакше з лендінга нікуди перейти" });
  }
  // A link button with no destination would render as a dead control.
  if (status === "published" && config.ctas.some((c) => c.enabled && c.type === "link" && !c.url)) {
    return jsonResponse(400, { error: "Вкажіть посилання (https://…) для кожної кнопки типу «Лінк» або вимкніть її" });
  }

  // Publishing is where a page becomes public on our domain, so that's where
  // the ClickFix guard sits (see _shared/landing-page.ts). A draft may still
  // be saved — it's invisible to visitors — so a false positive never costs
  // the operator their work. Every refusal is recorded for /admin/security.
  if (status === "published") {
    const signs = findClickFixSigns(config);
    if (signs.length > 0) {
      const { error: eventError } = await supabase.from("events").insert({
        org_id: orgId,
        type: "landing_publish_blocked",
        level: "warn",
        payload: { landing_page_id: id ?? null, slug, name, signs, user_id: userData.user.id },
      });
      if (eventError) console.error("save-landing-page: events insert failed", eventError);
      return jsonResponse(422, {
        error:
          `Публікацію заблоковано: на сторінці є фрази, типові для шахрайських «перевірок» (${signs.map((x) => (x.startsWith("«") && x.endsWith("»") ? x.slice(1, -1) : x)).join(", ")}). ` +
          "Такі сторінки просять відвідувача запустити команду на своєму компʼютері. Приберіть ці фрази й опублікуйте знову — як чернетку сторінку зберегти можна. Якщо це помилка, напишіть у підтримку.",
        signs,
      });
    }
  }

  // Created before touching the row so a failure here never leaves the row
  // pointing at a secret that doesn't exist.
  let newTokenSecretId: string | undefined;
  if (metaAccessToken) {
    const { data: secretId, error: secretError } = await supabase.rpc("vault_create_secret", {
      secret: metaAccessToken,
      name: `landing_capi_token_${orgId}_${Date.now()}`,
      description: "Meta CAPI access token (per landing page)",
    });
    if (secretError || !secretId) {
      console.error("save-landing-page: vault_create_secret failed", secretError);
      return jsonResponse(500, { error: "Не вдалося зберегти CAPI токен" });
    }
    newTokenSecretId = secretId;
  }

  const payload: Record<string, unknown> = {
    name,
    template_key: templateKey,
    slug,
    status,
    config,
    updated_at: new Date().toISOString(),
  };
  if (routingSent) {
    payload.funnel_id = funnelId;
    payload.entry_node_id = entryNodeId;
  }
  if (newTokenSecretId) payload.meta_access_token_secret_id = newTokenSecretId;
  else if (clearMetaToken) payload.meta_access_token_secret_id = null;

  let oldTokenSecretId: string | null = null;
  if (id && (newTokenSecretId || clearMetaToken)) {
    const { data: existing } = await supabase
      .from("landing_pages")
      .select("meta_access_token_secret_id")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    oldTokenSecretId = (existing?.meta_access_token_secret_id as string | null) ?? null;
  }

  const query = id
    ? supabase.from("landing_pages").update(payload).eq("id", id).eq("org_id", orgId)
    : supabase.from("landing_pages").insert({ ...payload, org_id: orgId });

  const { data, error } = await query.select("id, name, template_key, slug, status, config, meta_access_token_secret_id, funnel_id, entry_node_id").maybeSingle();

  if (error) {
    // UNIQUE(slug) is global, so this can be another org's page — the message
    // says "taken" and nothing about whose.
    if (error.code === UNIQUE_VIOLATION) return jsonResponse(409, { error: TAKEN_SLUG_ERROR });
    console.error("save-landing-page: write failed", error);
    return jsonResponse(500, { error: "Не вдалося зберегти лендінг" });
  }
  if (!data) return jsonResponse(404, { error: "Лендінг не знайдено" });

  if (oldTokenSecretId && oldTokenSecretId !== data.meta_access_token_secret_id) {
    const { error: vaultError } = await supabase.rpc("vault_delete_secret", { secret_id: oldTokenSecretId });
    if (vaultError) console.error("save-landing-page: vault_delete_secret (old token) failed", vaultError);
  }

  // The token itself never travels back — only whether one is stored.
  const { meta_access_token_secret_id: secretId, ...rest } = data;
  return jsonResponse(200, { ok: true, landingPage: { ...rest, hasMetaToken: !!secretId } });
};
