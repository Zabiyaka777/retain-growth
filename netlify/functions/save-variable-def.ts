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

const UNIQUE_VIOLATION = "23505";

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

  let key: string | undefined;
  let label: string | undefined;
  let deleteId: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    key = typeof body.key === "string" ? body.key.trim() : undefined;
    label = typeof body.label === "string" ? body.label.trim() : undefined;
    deleteId = body.delete === true && typeof body.id === "string" ? body.id : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!deleteId && (!key || !label)) {
    return jsonResponse(400, { error: "Ключ і назва обов'язкові" });
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
    const { error: deleteError } = await supabase.from("variable_defs").delete().eq("id", deleteId).eq("org_id", orgId);
    if (deleteError) {
      console.error("save-variable-def: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити змінну" });
    }
    return jsonResponse(200, { ok: true });
  }

  const { data: variableDef, error: insertError } = await supabase
    .from("variable_defs")
    .insert({ org_id: orgId, key, label })
    .select("id, key, label, created_at")
    .single();

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      return jsonResponse(409, { error: "Змінна з таким ключем вже існує" });
    }
    console.error("save-variable-def: insert failed", insertError);
    return jsonResponse(500, { error: "Не вдалося створити змінну" });
  }

  return jsonResponse(200, { ok: true, variableDef });
};
