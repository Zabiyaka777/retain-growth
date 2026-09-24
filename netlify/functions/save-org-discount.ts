import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { logAdminAction, requirePlatformAdmin } from "./_shared/platform-admin";

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

/**
 * Platform-admin-only CRUD for org_discounts. list/create/delete in one
 * endpoint, same shape as admin-organizations.ts (one function, an action
 * field). org_discounts has no client-writable RLS policy at all — this is
 * the only way any discount ever gets created or removed.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let action: "list" | "create" | "delete" | undefined;
  let orgId: string | undefined;
  let label: string | undefined;
  let percent: number | undefined;
  let expiresAt: string | null | undefined;
  let discountId: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    action = body.action === "list" || body.action === "create" || body.action === "delete" ? body.action : undefined;
    orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    label = typeof body.label === "string" ? body.label.trim() : undefined;
    percent = typeof body.percent === "number" ? body.percent : undefined;
    expiresAt = body.expiresAt === null ? null : typeof body.expiresAt === "string" ? body.expiresAt : undefined;
    discountId = typeof body.discountId === "string" ? body.discountId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!action || !orgId) {
    return jsonResponse(400, { error: "action і orgId обов'язкові" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) {
    return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });
  }

  if (action === "list") {
    const { data: discounts, error: listError } = await supabase
      .from("org_discounts")
      .select("id, label, percent, expires_at, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });

    if (listError) {
      console.error("save-org-discount: list failed", listError);
      return jsonResponse(500, { error: "Не вдалося отримати знижки" });
    }
    return jsonResponse(200, { ok: true, discounts: discounts ?? [] });
  }

  if (action === "create") {
    if (!label || percent === undefined || Number.isNaN(percent) || percent < 0 || percent > 100) {
      return jsonResponse(400, { error: "label обов'язковий, percent має бути від 0 до 100" });
    }

    const { data: discount, error: insertError } = await supabase
      .from("org_discounts")
      .insert({
        org_id: orgId,
        label,
        percent,
        created_by_admin_id: admin.userId,
        expires_at: expiresAt ?? null,
      })
      .select("id, label, percent, expires_at, created_at")
      .single();

    if (insertError) {
      console.error("save-org-discount: insert failed", insertError);
      return jsonResponse(500, { error: "Не вдалося створити знижку" });
    }

    await logAdminAction(supabase, admin, "org_discount_created", { label, percent, expires_at: expiresAt ?? null }, orgId);

    return jsonResponse(200, { ok: true, discount });
  }

  // action === "delete"
  if (!discountId) {
    return jsonResponse(400, { error: "discountId обов'язковий" });
  }

  // Read first — the audit log needs to describe what was removed, and that
  // information is gone the instant the row is.
  const { data: existing } = await supabase
    .from("org_discounts")
    .select("label, percent, expires_at")
    .eq("id", discountId)
    .eq("org_id", orgId)
    .maybeSingle();

  const { error: deleteError } = await supabase.from("org_discounts").delete().eq("id", discountId).eq("org_id", orgId);

  if (deleteError) {
    console.error("save-org-discount: delete failed", deleteError);
    return jsonResponse(500, { error: "Не вдалося видалити знижку" });
  }

  await logAdminAction(
    supabase,
    admin,
    "org_discount_deleted",
    { label: existing?.label ?? null, percent: existing?.percent ?? null, expires_at: existing?.expires_at ?? null },
    orgId,
  );

  return jsonResponse(200, { ok: true });
};
