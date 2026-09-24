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

// The two built-in stages sit at 0 and 1000 (see the create_funnel_stages
// migration). Custom stages are appended in the gap between them.
const LOCKED_END_POSITION = 1000;
const FIRST_CUSTOM_POSITION = 100;

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
  let deleteId: string | undefined;
  let updateId: string | undefined;
  let trackAsConversion = false;
  let metaEventName: string | null = null;
  try {
    const body = JSON.parse(event.body || "{}");
    name = typeof body.name === "string" ? body.name.trim() : undefined;
    deleteId = body.delete === true && typeof body.id === "string" ? body.id : undefined;
    // Same endpoint updates an existing stage's conversion config, so a stage
    // created before the feature (or before the campaign needed it) can be
    // switched on without being recreated.
    updateId = !deleteId && typeof body.id === "string" ? body.id : undefined;
    trackAsConversion = body.trackAsConversion === true;
    metaEventName = typeof body.metaEventName === "string" && body.metaEventName.trim() ? body.metaEventName.trim() : null;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!deleteId && !updateId && !name) {
    return jsonResponse(400, { error: "Назва обов'язкова" });
  }

  // Meta needs to know *what* the conversion is; sending an unnamed event
  // would silently land as a generic "Lead" and be untraceable in Ads Manager.
  if (trackAsConversion && !metaEventName) {
    return jsonResponse(400, { error: "Вкажіть назву події Meta для конверсійного етапу" });
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
    // .eq("org_id", orgId) alone already protects the built-ins: their org_id
    // is NULL, so they can never match and can't be deleted through here.
    const { error: deleteError } = await supabase
      .from("funnel_stages")
      .delete()
      .eq("id", deleteId)
      .eq("org_id", orgId)
      .eq("is_locked", false);
    if (deleteError) {
      console.error("save-funnel-stage: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити етап" });
    }
    return jsonResponse(200, { ok: true });
  }

  if (updateId) {
    const { data: target, error: targetError } = await supabase
      .from("funnel_stages")
      .select("id, name, is_locked, position, org_id")
      .eq("id", updateId)
      .maybeSingle();
    if (targetError || !target || (target.org_id !== null && target.org_id !== orgId)) {
      return jsonResponse(404, { error: "Етап не знайдено" });
    }

    // A built-in is one shared row, so its config is stored per-org in
    // org_stage_conversion — writing the columns would change it for
    // every org at once.
    if (target.org_id === null) {
      const { error: overrideError } = await supabase.from("org_stage_conversion").upsert(
        {
          org_id: orgId,
          stage_id: updateId,
          track_as_conversion: trackAsConversion,
          meta_event_name: metaEventName,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "org_id,stage_id" },
      );
      if (overrideError) {
        console.error("save-funnel-stage: override upsert failed", overrideError);
        return jsonResponse(500, { error: "Не вдалося оновити етап" });
      }
      return jsonResponse(200, {
        ok: true,
        stage: {
          id: target.id,
          name: target.name,
          is_locked: target.is_locked,
          position: target.position,
          track_as_conversion: trackAsConversion,
          meta_event_name: metaEventName,
        },
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from("funnel_stages")
      .update({ track_as_conversion: trackAsConversion, meta_event_name: metaEventName })
      .eq("id", updateId)
      .eq("org_id", orgId)
      .select("id, name, is_locked, position, track_as_conversion, meta_event_name")
      .maybeSingle();
    if (updateError) {
      console.error("save-funnel-stage: update failed", updateError);
      return jsonResponse(500, { error: "Не вдалося оновити етап" });
    }
    if (!updated) {
      return jsonResponse(404, { error: "Етап не знайдено" });
    }
    return jsonResponse(200, { ok: true, stage: updated });
  }

  const { data: lastCustom } = await supabase
    .from("funnel_stages")
    .select("position")
    .eq("org_id", orgId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextPosition = lastCustom
    ? Math.min((lastCustom.position as number) + 10, LOCKED_END_POSITION - 1)
    : FIRST_CUSTOM_POSITION;

  const { data: stage, error: insertError } = await supabase
    .from("funnel_stages")
    .insert({
      org_id: orgId,
      name,
      is_locked: false,
      position: nextPosition,
      track_as_conversion: trackAsConversion,
      meta_event_name: metaEventName,
    })
    .select("id, name, is_locked, position, track_as_conversion, meta_event_name")
    .single();

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      return jsonResponse(409, { error: "Етап з такою назвою вже існує" });
    }
    console.error("save-funnel-stage: insert failed", insertError);
    return jsonResponse(500, { error: "Не вдалося створити етап" });
  }

  return jsonResponse(200, { ok: true, stage });
};
