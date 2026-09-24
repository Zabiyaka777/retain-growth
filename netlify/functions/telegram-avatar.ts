import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = "lead-avatars";

// How long an answer from Telegram is trusted — both "here is the photo"
// and "no photo / hidden by privacy settings". A week keeps a changed photo
// from lagging too far behind without asking Telegram on every page view.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// One call is one visible list (a page of threads or CRM rows). Each fetch is
// three Telegram round trips plus an upload, so the per-call budget is capped
// to stay well inside the function timeout; whatever is left is reported as
// pending and the client simply asks again.
const MAX_FETCHES_PER_CALL = 12;
const CONCURRENCY = 4;
// Telegram returns several sizes of the same photo; the list/avatars render
// at 32–48px, so the smallest one at least this wide is plenty on 2x screens.
const TARGET_WIDTH = 120;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// ".../storage/v1/object/public/lead-avatars/<org>/<lead>-<id>.jpg" → "<org>/<lead>-<id>.jpg"
function objectPath(publicUrl: string): string | null {
  const marker = `/object/public/${BUCKET}/`;
  const at = publicUrl.indexOf(marker);
  return at === -1 ? null : decodeURIComponent(publicUrl.slice(at + marker.length));
}

interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
}

/**
 * Asks Telegram for the lead's current profile photo and copies it into our
 * own Storage. Returns the public URL, or null when there is no photo (or the
 * lead's privacy settings hide it from bots). Throws only on transport-level
 * failures, so those are retried next time instead of being cached as "none".
 */
async function fetchAvatar(supabase: SupabaseClient, botToken: string, orgId: string, lead: { id: string; external_id: string }): Promise<string | null> {
  const photosRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${encodeURIComponent(lead.external_id)}&limit=1`,
  );
  const photos = (await photosRes.json()) as { ok: boolean; result?: { total_count: number; photos: PhotoSize[][] } };
  if (!photos.ok) throw new Error(`getUserProfilePhotos failed (${photosRes.status})`);
  const sizes = photos.result?.photos?.[0];
  if (!sizes || sizes.length === 0) return null;

  const sorted = sizes.slice().sort((a, b) => a.width - b.width);
  const pick = sorted.find((s) => s.width >= TARGET_WIDTH) ?? sorted[sorted.length - 1];

  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(pick.file_id)}`);
  const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string } };
  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) throw new Error(`getFile failed (${infoRes.status})`);

  // This URL carries the bot token — it is only ever fetched here, never
  // stored or returned.
  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!fileRes.ok) throw new Error(`file download failed (${fileRes.status})`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  // Random suffix: the bucket is public, so the object name is what keeps the
  // URL from being guessable. A new name per fetch also busts browser caches
  // when the lead changes their photo.
  const path = `${orgId}/${lead.id}-${nanoid(10)}.jpg`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: "image/jpeg", upsert: false });
  if (uploadError) throw new Error(`upload failed: ${uploadError.message}`);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * POST { leadIds } → { avatars: { [leadId]: url | null }, pending: leadId[] }
 *
 * Refreshes the Telegram profile-photo cache (leads.avatar_url /
 * avatar_checked_at) for the given leads of the caller's org. The UI reads
 * avatar_url straight from its own lead queries and only calls this for rows
 * whose cache is missing or older than TTL_MS. Non-Telegram leads, and leads
 * of another org, are ignored. org_id comes from the session (CLAUDE.md).
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let leadIds: string[] = [];
  try {
    const body = JSON.parse(event.body || "{}");
    if (Array.isArray(body.leadIds)) {
      leadIds = [...new Set((body.leadIds as unknown[]).filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 100);
    }
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (leadIds.length === 0) return jsonResponse(200, { avatars: {}, pending: [] });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonResponse(401, { error: "Недійсна сесія" });
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (!profile) return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  const orgId = profile.org_id as string;

  const { data: leads, error: leadsError } = await supabase
    .from("leads")
    .select("id, external_id, avatar_url, avatar_checked_at")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .in("id", leadIds);
  if (leadsError) {
    console.error("telegram-avatar: leads lookup failed", leadsError);
    return jsonResponse(500, { error: "Не вдалося прочитати лідів" });
  }

  const avatars: Record<string, string | null> = {};
  const now = Date.now();
  const stale: { id: string; external_id: string; previous: string | null }[] = [];
  for (const lead of leads ?? []) {
    const checked = lead.avatar_checked_at ? Date.parse(lead.avatar_checked_at as string) : NaN;
    if (Number.isFinite(checked) && now - checked < TTL_MS) avatars[lead.id as string] = (lead.avatar_url as string | null) ?? null;
    else stale.push({ id: lead.id as string, external_id: lead.external_id as string, previous: (lead.avatar_url as string | null) ?? null });
  }
  if (stale.length === 0) return jsonResponse(200, { avatars, pending: [] });

  const { data: credential } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .maybeSingle();
  const { data: botToken } = credential
    ? await supabase.rpc("vault_read_secret", { secret_id: credential.bot_token_secret_id })
    : { data: null };
  if (!botToken) {
    // No bot to ask — leave the cache untouched so it fills in once one is connected.
    for (const lead of stale) avatars[lead.id] = lead.previous;
    return jsonResponse(200, { avatars, pending: [] });
  }

  const batch = stale.slice(0, MAX_FETCHES_PER_CALL);
  const pending = stale.slice(MAX_FETCHES_PER_CALL).map((l) => l.id);

  let next = 0;
  async function worker() {
    while (next < batch.length) {
      const lead = batch[next++];
      try {
        const url = await fetchAvatar(supabase, botToken as string, orgId, lead);
        avatars[lead.id] = url;
        const { error } = await supabase
          .from("leads")
          .update({ avatar_url: url, avatar_checked_at: new Date().toISOString() })
          .eq("id", lead.id)
          .eq("org_id", orgId);
        if (error) console.error("telegram-avatar: cache update failed", lead.id, error);
        // The previous copy is now unreferenced — drop it so refreshes don't
        // pile up files in the bucket. Best-effort.
        const oldPath = lead.previous ? objectPath(lead.previous) : null;
        if (!error && oldPath && lead.previous !== url) {
          const { error: removeError } = await supabase.storage.from(BUCKET).remove([oldPath]);
          if (removeError) console.error("telegram-avatar: old avatar cleanup failed", oldPath, removeError);
        }
      } catch (err) {
        // Not cached as "no photo": a Telegram hiccup shouldn't hide the
        // avatar for a week. The previous URL, if any, stays in place.
        console.error("telegram-avatar: fetch failed", lead.id, err);
        avatars[lead.id] = lead.previous;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));

  return jsonResponse(200, { avatars, pending });
};
