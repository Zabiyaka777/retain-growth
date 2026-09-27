import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

type Kind = "comment" | "story";

// Same create/update/delete-in-one-file shape as save-quick-reply.ts:
// body.id present -> update, body.delete === true -> delete, else create.
interface Body {
  kind?: Kind;
  id?: string;
  delete?: boolean;
  name?: string;
  scope?: string;
  mediaId?: string | null;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  isActive?: boolean;
  // comment-only
  replyVariants?: string[];
  dmFunnelNodeId?: string | null;
  // story-only
  reactToReply?: boolean;
  reactToMention?: boolean;
  activeFrom?: string | null;
  activeUntil?: string | null;
  autoLike?: boolean;
  replyFunnelNodeId?: string | null;
}

function cleanStrings(arr: unknown): string[] {
  return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
}

/** Confirms a funnel_node belongs to this org (funnel_nodes has no org_id of its own). */
async function ownsFunnelNode(supabase: SupabaseClient, orgId: string, nodeId: string): Promise<{ ok: boolean; config?: Record<string, unknown> }> {
  const { data: node } = await supabase.from("funnel_nodes").select("config, funnels!inner(org_id)").eq("id", nodeId).maybeSingle();
  const ownerOrgId = (node as unknown as { funnels?: { org_id?: string } } | null)?.funnels?.org_id;
  if (!node || ownerOrgId !== orgId) return { ok: false };
  return { ok: true, config: (node.config ?? {}) as Record<string, unknown> };
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

  let body: Body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const kind = body.kind === "comment" || body.kind === "story" ? body.kind : undefined;
  if (!kind) return jsonResponse(400, { error: "Некоректний тип тригера" });

  const table = kind === "comment" ? "instagram_comment_triggers" : "instagram_story_triggers";

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request (see CLAUDE.md: org_id scoping).
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }
  const orgId = profile.org_id as string;

  if (body.delete === true && typeof body.id === "string") {
    const { error: deleteError } = await supabase.from(table).delete().eq("id", body.id).eq("org_id", orgId);
    if (deleteError) {
      console.error("save-instagram-trigger: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити тригер" });
    }
    return jsonResponse(200, { ok: true });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return jsonResponse(400, { error: "Назва обов'язкова" });

  const includeKeywords = cleanStrings(body.includeKeywords);
  const excludeKeywords = cleanStrings(body.excludeKeywords);
  const isActive = body.isActive !== false;

  if (kind === "comment") {
    const scope = body.scope === "all_lives" || body.scope === "specific_post" ? body.scope : "all_posts";
    const mediaId = typeof body.mediaId === "string" && body.mediaId.trim() ? body.mediaId.trim() : null;
    if (scope === "specific_post" && !mediaId) {
      return jsonResponse(400, { error: "Вкажіть ID поста для конкретного посту" });
    }
    const replyVariants = cleanStrings(body.replyVariants);
    const dmFunnelNodeId = typeof body.dmFunnelNodeId === "string" && body.dmFunnelNodeId ? body.dmFunnelNodeId : null;

    // Hardcoded rule (ТЗ item 3), checked here too so the operator sees the
    // problem immediately rather than finding out from a failed webhook
    // event tomorrow: the DM node must exist, belong to this org, and carry
    // at least one button plus Instagram DM text. instagram-webhook.ts
    // re-checks this at send time regardless — this is belt-and-braces, not
    // the only guard.
    if (dmFunnelNodeId) {
      const owned = await ownsFunnelNode(supabase, orgId, dmFunnelNodeId);
      if (!owned.ok) return jsonResponse(404, { error: "Вузол DM не знайдено в цій організації" });
      const config = owned.config as { buttons?: { label?: string }[]; channels?: { instagram?: { blocks?: { kind?: string; text?: string }[] } } };
      const hasButton = (config.buttons ?? []).some((b) => b?.label);
      const hasText = !!config.channels?.instagram?.blocks?.find((b) => b.kind === "text")?.text?.trim();
      if (!hasButton) {
        return jsonResponse(400, { error: "Перше DM-повідомлення на цю точку входу обов'язково повинно мати кнопку (вимога Meta) — додайте кнопку на обраному вузлі в конструкторі воронок" });
      }
      if (!hasText) {
        return jsonResponse(400, { error: "На обраному вузлі порожній текст у вкладці Instagram" });
      }
    }

    const row = {
      org_id: orgId,
      name,
      scope,
      media_id: mediaId,
      include_keywords: includeKeywords,
      exclude_keywords: excludeKeywords,
      reply_variants: replyVariants,
      dm_funnel_node_id: dmFunnelNodeId,
      is_active: isActive,
      updated_at: new Date().toISOString(),
    };

    const query = body.id
      ? supabase.from(table).update(row).eq("id", body.id).eq("org_id", orgId)
      : supabase.from(table).insert(row);
    const { data: trigger, error: saveError } = await query.select().single();
    if (saveError || !trigger) {
      console.error("save-instagram-trigger: comment save failed", saveError);
      return jsonResponse(500, { error: "Не вдалося зберегти тригер" });
    }
    return jsonResponse(200, { ok: true, trigger });
  }

  // kind === "story"
  const scope = body.scope === "specific_story" ? "specific_story" : "all_stories";
  const storyMediaId = typeof body.mediaId === "string" && body.mediaId.trim() ? body.mediaId.trim() : null;
  if (scope === "specific_story" && !storyMediaId) {
    return jsonResponse(400, { error: "Вкажіть ID Stories для конкретної історії" });
  }
  const activeFrom = typeof body.activeFrom === "string" && body.activeFrom ? body.activeFrom : null;
  const activeUntil = typeof body.activeUntil === "string" && body.activeUntil ? body.activeUntil : null;
  if (activeFrom && activeUntil && activeFrom > activeUntil) {
    return jsonResponse(400, { error: "Дата початку пізніше дати завершення" });
  }
  const replyFunnelNodeId = typeof body.replyFunnelNodeId === "string" && body.replyFunnelNodeId ? body.replyFunnelNodeId : null;
  if (replyFunnelNodeId) {
    const owned = await ownsFunnelNode(supabase, orgId, replyFunnelNodeId);
    if (!owned.ok) return jsonResponse(404, { error: "Вузол не знайдено в цій організації" });
  }

  const row = {
    org_id: orgId,
    name,
    react_to_reply: body.reactToReply !== false,
    react_to_mention: body.reactToMention !== false,
    scope,
    story_media_id: storyMediaId,
    active_from: activeFrom,
    active_until: activeUntil,
    auto_like: body.autoLike === true,
    include_keywords: includeKeywords,
    exclude_keywords: excludeKeywords,
    reply_funnel_node_id: replyFunnelNodeId,
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };

  const query = body.id ? supabase.from(table).update(row).eq("id", body.id).eq("org_id", orgId) : supabase.from(table).insert(row);
  const { data: trigger, error: saveError } = await query.select().single();
  if (saveError || !trigger) {
    console.error("save-instagram-trigger: story save failed", saveError);
    return jsonResponse(500, { error: "Не вдалося зберегти тригер" });
  }
  return jsonResponse(200, { ok: true, trigger });
};
