import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

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

// Same create/update/delete-in-one-file shape as save-quick-reply.ts /
// save-instagram-trigger.ts: body.id present -> update, body.delete === true
// -> delete, else create.
interface Body {
  id?: string;
  delete?: boolean;
  name?: string;
  description?: string | null;
  priceAmount?: number; // major units from the form — converted to minor below
  ccy?: number;
  kind?: "one_time" | "recurring";
  interval?: "week" | "month" | "year" | null;
  imageUrl?: string | null;
  isActive?: boolean;
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
    // Subscriptions reference offers with ON DELETE RESTRICT on purpose — an
    // offer with active subscribers can't be silently removed out from under
    // them. Deactivating (is_active=false) is the intended way to retire one.
    const { error: deleteError } = await supabase.from("offers").delete().eq("id", body.id).eq("org_id", orgId);
    if (deleteError) {
      if (deleteError.code === "23503") {
        return jsonResponse(409, { error: "Оффер має підписників — деактивуйте його замість видалення" });
      }
      console.error("save-offer: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити оффер" });
    }
    return jsonResponse(200, { ok: true });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const priceAmountMajor = typeof body.priceAmount === "number" ? body.priceAmount : NaN;
  const kind = body.kind === "recurring" ? "recurring" : "one_time";
  const interval = kind === "recurring" && (body.interval === "week" || body.interval === "month" || body.interval === "year") ? body.interval : null;

  if (!name) return jsonResponse(400, { error: "Назва обов'язкова" });
  if (!Number.isFinite(priceAmountMajor) || priceAmountMajor <= 0) return jsonResponse(400, { error: "Ціна має бути більшою за нуль" });
  if (kind === "recurring" && !interval) return jsonResponse(400, { error: "Для рекурентного оффера вкажіть інтервал" });

  const row = {
    org_id: orgId,
    name,
    description: typeof body.description === "string" ? body.description.trim() || null : null,
    price_amount: Math.round(priceAmountMajor * 100),
    ccy: typeof body.ccy === "number" ? body.ccy : 980,
    kind,
    interval,
    image_url: typeof body.imageUrl === "string" ? body.imageUrl.trim() || null : null,
    is_active: body.isActive !== false,
    updated_at: new Date().toISOString(),
  };

  const query = body.id ? supabase.from("offers").update(row).eq("id", body.id).eq("org_id", orgId) : supabase.from("offers").insert(row);
  const { data: offer, error: saveError } = await query.select().single();
  if (saveError || !offer) {
    console.error("save-offer: save failed", saveError);
    return jsonResponse(500, { error: "Не вдалося зберегти оффер" });
  }

  return jsonResponse(200, { ok: true, offer });
};
