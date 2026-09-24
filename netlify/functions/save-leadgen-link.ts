import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { customAlphabet } from "nanoid";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const UNIQUE_VIOLATION = "23505";
// Unambiguous alphabet (no 0/O/1/I/l) — these tokens end up in short links
// people read/type/click, so avoid characters that are easy to misread.
const generateRefToken = customAlphabet("23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ", 8);
const MAX_TOKEN_ATTEMPTS = 5;

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let name: string | undefined;
  let funnelId: string | undefined;
  let entryNodeId: string | undefined;
  let pixelId: string | null = null;
  let id: string | undefined;
  let deleteId: string | undefined;
  // undefined = field left blank in the request — since the form never shows
  // the decrypted token back, blank on an edit always means "keep whatever
  // is already saved", never "clear it". Only a non-empty submission ever
  // touches the stored secret.
  let metaAccessToken: string | undefined;
  let metaTestEventCode: string | null = null;
  // null clears the page, undefined/absent leaves the column as-is on an edit.
  let landingPageId: string | null | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    name = typeof body.name === "string" ? body.name.trim() : undefined;
    funnelId = typeof body.funnelId === "string" ? body.funnelId : undefined;
    entryNodeId = typeof body.entryNodeId === "string" ? body.entryNodeId : undefined;
    pixelId = typeof body.pixelId === "string" && body.pixelId.trim() ? body.pixelId.trim() : null;
    metaAccessToken = typeof body.metaAccessToken === "string" && body.metaAccessToken.trim() ? body.metaAccessToken.trim() : undefined;
    metaTestEventCode = typeof body.metaTestEventCode === "string" && body.metaTestEventCode.trim() ? body.metaTestEventCode.trim() : null;
    landingPageId = body.landingPageId === null ? null : typeof body.landingPageId === "string" && body.landingPageId ? body.landingPageId : undefined;
    id = typeof body.id === "string" ? body.id : undefined;
    deleteId = body.delete === true && typeof body.id === "string" ? body.id : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!deleteId && (!name || !funnelId || !entryNodeId)) {
    return jsonResponse(400, { error: "name, funnelId і entryNodeId обов'язкові" });
  }

  // Meta System User/App/User tokens are a single unbroken run of letters and
  // digits — no spaces, colons, dashes, or newlines. This catches a pasted
  // label ("TOKEN: ..."), a stray newline, or a whole other chunk of text
  // landing in the field, before it ever reaches Vault. Not pinned to a
  // specific length or "EAA" prefix (that would break a legitimate token of
  // another type/length) — just rejects what's clearly too short or
  // suspiciously long (a real token runs ~150-220 chars; a full account dump
  // pasted by mistake is orders of magnitude longer).
  if (metaAccessToken && !/^[A-Za-z0-9]{40,300}$/.test(metaAccessToken)) {
    return jsonResponse(400, {
      error: "Токен доступу має бути одним рядком з латинських літер і цифр, без пробілів, переносів рядків чи іншого тексту",
    });
  }

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request (see CLAUDE.md: org_id scoping).
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }

  const orgId = profile.org_id as string;

  if (deleteId) {
    const { error: deleteError } = await supabase.from("lead_gen_links").delete().eq("id", deleteId).eq("org_id", orgId);
    if (deleteError) {
      console.error("save-leadgen-link: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити лінк" });
    }
    return jsonResponse(200, { ok: true });
  }

  const { data: funnel, error: funnelError } = await supabase
    .from("funnels")
    .select("id")
    .eq("id", funnelId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (funnelError || !funnel) {
    return jsonResponse(404, { error: "Воронку не знайдено" });
  }

  // Must belong to this exact funnel and be an entry node — a stray id from
  // a different funnel (or a non-entry node) would silently misroute every
  // lead who clicks this link.
  const { data: entryNode, error: entryNodeError } = await supabase
    .from("funnel_nodes")
    .select("id")
    .eq("id", entryNodeId)
    .eq("funnel_id", funnelId)
    .eq("type", "entry")
    .maybeSingle();

  if (entryNodeError || !entryNode) {
    return jsonResponse(404, { error: "Точку входу не знайдено в обраному тунелі" });
  }

  // Must be this org's page — an id from another org would otherwise let one
  // tenant route its leads through someone else's landing.
  if (landingPageId) {
    const { data: page } = await supabase.from("landing_pages").select("id").eq("id", landingPageId).eq("org_id", orgId).maybeSingle();
    if (!page) return jsonResponse(404, { error: "Лендінг не знайдено" });
  }

  // vault.secrets.name is uniquely indexed and is only a human-readable label
  // (lookups always go through lead_gen_links.meta_access_token_secret_id) —
  // the timestamp suffix keeps a token replacement from colliding with the
  // still-live old secret. Created before touching the row so a failure here
  // never leaves the row referencing a secret that doesn't exist.
  let newTokenSecretId: string | undefined;
  if (metaAccessToken) {
    const { data: secretId, error: secretError } = await supabase.rpc("vault_create_secret", {
      secret: metaAccessToken,
      name: `meta_capi_token_${orgId}_${Date.now()}`,
      description: "Meta CAPI access token (per lead-gen link)",
    });
    if (secretError || !secretId) {
      console.error("save-leadgen-link: vault_create_secret failed", secretError);
      return jsonResponse(500, { error: "Не вдалося зберегти CAPI токен" });
    }
    newTokenSecretId = secretId;
  }

  let link: { id: string; ref_token: string; meta_access_token_secret_id: string | null; landing_page_id: string | null } | null = null;

  if (id) {
    // Update: name/funnel/tag can change, ref_token never does — the links
    // already handed out for this record must keep working.
    let oldTokenSecretId: string | null = null;
    if (newTokenSecretId) {
      const { data: existing } = await supabase
        .from("lead_gen_links")
        .select("meta_access_token_secret_id")
        .eq("id", id)
        .eq("org_id", orgId)
        .maybeSingle();
      oldTokenSecretId = (existing?.meta_access_token_secret_id as string | null) ?? null;
    }

    const updatePayload: Record<string, unknown> = {
      name,
      funnel_id: funnelId,
      entry_node_id: entryNodeId,
      pixel_id: pixelId,
      meta_test_event_code: metaTestEventCode,
    };
    if (landingPageId !== undefined) updatePayload.landing_page_id = landingPageId;
    // Omitted entirely (not set to null) when no new token was submitted —
    // see the metaAccessToken comment above for why blank must never clear it.
    if (newTokenSecretId) updatePayload.meta_access_token_secret_id = newTokenSecretId;

    const { data, error: updateError } = await supabase
      .from("lead_gen_links")
      .update(updatePayload)
      .eq("id", id)
      .eq("org_id", orgId)
      .select("id, ref_token, meta_access_token_secret_id, landing_page_id")
      .maybeSingle();

    if (updateError) {
      console.error("save-leadgen-link: update failed", updateError);
      return jsonResponse(500, { error: "Не вдалося оновити лінк" });
    }
    if (!data) {
      return jsonResponse(404, { error: "Лінк не знайдено" });
    }
    link = data;

    // Only now has the row stopped pointing at the old secret, so deleting it
    // no longer trips the FK's NO ACTION restriction (same lesson as connect-telegram).
    if (oldTokenSecretId) {
      const { error } = await supabase.rpc("vault_delete_secret", { secret_id: oldTokenSecretId });
      if (error) console.error("save-leadgen-link: vault_delete_secret (old meta token) failed", error);
    }
  } else {
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS && !link; attempt++) {
      const refToken = generateRefToken();
      const { data, error: insertError } = await supabase
        .from("lead_gen_links")
        .insert({
          org_id: orgId,
          name,
          funnel_id: funnelId,
          entry_node_id: entryNodeId,
          pixel_id: pixelId,
          meta_access_token_secret_id: newTokenSecretId ?? null,
          meta_test_event_code: metaTestEventCode,
          landing_page_id: landingPageId ?? null,
          ref_token: refToken,
        })
        .select("id, ref_token, meta_access_token_secret_id, landing_page_id")
        .single();

      if (!insertError) {
        link = data;
        break;
      }
      if (insertError.code !== UNIQUE_VIOLATION) {
        console.error("save-leadgen-link: insert failed", insertError);
        return jsonResponse(500, { error: "Не вдалося створити лінк" });
      }
      // ref_token collision (astronomically unlikely at 8 chars) — retry with a new one.
    }

    if (!link) {
      console.error("save-leadgen-link: exhausted ref_token attempts");
      return jsonResponse(500, { error: "Не вдалося створити унікальний токен, спробуйте ще раз" });
    }
  }

  const origin = `https://${event.headers.host}`;
  const urls = {
    telegram: `${origin}/r/${link.ref_token}?ch=telegram`,
    whatsapp: `${origin}/r/${link.ref_token}?ch=whatsapp`,
    fbm: `${origin}/r/${link.ref_token}?ch=fbm`,
  };

  return jsonResponse(200, {
    ok: true,
    link: {
      id: link.id,
      name,
      funnelId,
      entryNodeId,
      pixelId,
      metaTestEventCode,
      hasMetaToken: !!link.meta_access_token_secret_id,
      landingPageId: link.landing_page_id,
      refToken: link.ref_token,
    },
    urls,
  });
};
