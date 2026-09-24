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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter has no Whisper-style /audio/transcriptions endpoint — audio goes
// through chat completions as an `input_audio` content part, and only to a
// model whose architecture lists "audio" as an input modality (checked
// against https://openrouter.ai/api/v1/models: 46 of them at time of writing).
//
// gemini-2.5-flash-lite is the cheapest generally-available one for audio
// input and returns text, which is all a transcript needs. Overridable
// without a deploy for when a better/cheaper one appears.
const DEFAULT_MODEL = process.env.TRANSCRIBE_MODEL || "google/gemini-2.5-flash-lite";

const MAX_TOKENS = 2000;

// Formats OpenRouter documents for input_audio. Telegram voice notes are
// OGG/Opus in a .oga container, which maps to "ogg".
const FORMAT_BY_EXTENSION: Record<string, string> = {
  oga: "ogg",
  ogg: "ogg",
  opus: "ogg",
  mp3: "mp3",
  m4a: "m4a",
  wav: "wav",
  flac: "flac",
  aac: "aac",
  aiff: "aiff",
};

const TRANSCRIBE_PROMPT =
  "Це голосове повідомлення від клієнта. Розшифруй його дослівно тією мовою, якою воно записане. " +
  "Поверни ЛИШЕ текст розшифровки, без лапок, без коментарів і без опису аудіо. " +
  "Якщо мови не чути або запис порожній — поверни рівно: [нерозбірливо]";

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface Attachment {
  type?: string;
  url?: string;
  filename?: string;
}

function pickVoiceAttachment(meta: unknown): Attachment | null {
  const attachments = (meta as { attachments?: Attachment[] } | null)?.attachments;
  if (!Array.isArray(attachments)) return null;
  return attachments.find((a) => a?.url && (a.type === "voice" || a.type === "audio")) ?? null;
}

function formatFor(attachment: Attachment): string {
  const source = attachment.filename ?? attachment.url ?? "";
  const ext = source.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_BY_EXTENSION[ext] ?? "ogg";
}

/**
 * Transcribes one voice message into messages.transcript.
 *
 * Internal, service-to-service (same x-internal-secret guard as ai-respond.ts):
 * it spends the org's OpenRouter credit, so it must never be reachable from a
 * browser. Idempotent — a message that already has a transcript is left alone,
 * so a retried webhook can't pay for the same audio twice.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const internalSecret = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  if (internalSecret !== serviceRoleKey) {
    console.error("transcribe-voice: rejected call without internal secret");
    return jsonResponse(401, { error: "Unauthorized" });
  }

  let messageId: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    messageId = typeof body.messageId === "string" ? body.messageId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!messageId) {
    return jsonResponse(400, { error: "messageId обов'язковий" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("id, org_id, meta, transcript")
    .eq("id", messageId)
    .maybeSingle();

  if (messageError || !message) {
    console.error("transcribe-voice: message not found", messageId, messageError);
    return jsonResponse(404, { error: "Повідомлення не знайдено" });
  }

  if (message.transcript) {
    return jsonResponse(200, { ok: true, reason: "already_transcribed" });
  }

  const attachment = pickVoiceAttachment(message.meta);
  if (!attachment?.url) {
    return jsonResponse(400, { error: "У повідомленні немає голосового вкладення" });
  }

  const orgId = message.org_id as string;

  const { data: credential, error: credentialError } = await supabase
    .from("ai_credentials")
    .select("api_key_secret_id")
    .eq("org_id", orgId)
    .maybeSingle();

  // No AI key connected: an explicit, findable event rather than a silent
  // no-op. The message itself is already saved and playable either way.
  if (credentialError || !credential?.api_key_secret_id) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "transcription_skipped",
      level: "warn",
      payload: { reason: "no_ai_key", message_id: messageId },
    });
    if (eventError) console.error("transcribe-voice: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "no_ai_key" });
  }

  const { data: apiKey, error: keyError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.api_key_secret_id,
  });

  if (keyError || !apiKey) {
    console.error("transcribe-voice: failed to decrypt api key", keyError);
    return jsonResponse(500, { error: "Не вдалося прочитати AI-ключ" });
  }

  let audioBase64: string;
  try {
    const fileRes = await fetch(attachment.url);
    if (!fileRes.ok) {
      throw new Error(`storage ${fileRes.status}`);
    }
    audioBase64 = Buffer.from(await fileRes.arrayBuffer()).toString("base64");
  } catch (err) {
    console.error("transcribe-voice: audio download failed", err);
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "transcription_failed",
      level: "error",
      payload: { reason: "download_failed", message_id: messageId, url: attachment.url },
    });
    if (eventError) console.error("transcribe-voice: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "download_failed" });
  }

  const model = DEFAULT_MODEL;

  let transcript = "";
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-Title": "Retain Growth",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: TRANSCRIBE_PROMPT },
              { type: "input_audio", input_audio: { data: audioBase64, format: formatFor(attachment) } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    transcript = (data.choices?.[0]?.message?.content ?? "").trim();
  } catch (err) {
    console.error("transcribe-voice: OpenRouter call failed", err);
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "transcription_failed",
      level: "error",
      payload: { reason: "provider_error", model, message_id: messageId, message: err instanceof Error ? err.message : String(err) },
    });
    if (eventError) console.error("transcribe-voice: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "provider_error" });
  }

  if (!transcript) {
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "transcription_failed",
      level: "error",
      payload: { reason: "empty_result", model, message_id: messageId },
    });
    if (eventError) console.error("transcribe-voice: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "empty_result" });
  }

  const { error: updateError } = await supabase.from("messages").update({ transcript }).eq("id", messageId);

  if (updateError) {
    console.error("transcribe-voice: transcript update failed", updateError);
    return jsonResponse(500, { error: "Не вдалося зберегти розшифровку" });
  }

  return jsonResponse(200, { ok: true, transcript });
};
