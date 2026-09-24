import type { Handler } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const BUCKET = "message-attachments";
// Netlify Functions cap synchronous request bodies at ~6MB; base64 inflates
// the raw file by ~1.37x, so 4MB raw is the safe ceiling for this MVP
// (bucket-level file_size_limit is set slightly higher as a backstop).
const MAX_FILE_BYTES = 4 * 1024 * 1024;

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

  let filename: string | undefined;
  let contentType: string | undefined;
  let dataBase64: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    filename = typeof body.filename === "string" ? body.filename : undefined;
    contentType = typeof body.contentType === "string" ? body.contentType : undefined;
    dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!filename || !contentType || !dataBase64) {
    return jsonResponse(400, { error: "filename, contentType і dataBase64 обов'язкові" });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, "base64");
  } catch {
    return jsonResponse(400, { error: "Некоректні дані файлу" });
  }

  if (buffer.byteLength === 0) {
    return jsonResponse(400, { error: "Порожній файл" });
  }
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return jsonResponse(413, { error: `Файл завеликий (макс. ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB)` });
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
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  const path = `${orgId}/${randomUUID()}-${safeName}`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: false });

  if (uploadError) {
    console.error("upload-attachment: upload failed", uploadError);
    return jsonResponse(500, { error: "Не вдалося завантажити файл" });
  }

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

  return jsonResponse(200, { ok: true, url: publicUrlData.publicUrl, filename });
};
