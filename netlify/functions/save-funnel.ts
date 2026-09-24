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

// Mirrors the step shape funnel-processor.ts already reads from
// funnels.definition — do not diverge from this format.
interface FunnelStep {
  type: "message" | "wait";
  text?: string;
  minutes?: number;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function validateDefinition(definition: unknown): string | null {
  if (!Array.isArray(definition) || definition.length === 0) {
    return "Потрібен хоча б один крок";
  }
  const steps = definition as FunnelStep[];
  if (steps[0]?.type === "wait") return "Перший крок не може бути затримкою";
  if (steps[steps.length - 1]?.type === "wait") return "Останній крок не може бути затримкою";
  for (const step of steps) {
    if (step.type === "message") {
      if (typeof step.text !== "string" || !step.text.trim()) return "Текст повідомлення не може бути порожнім";
    } else if (step.type === "wait") {
      if (typeof step.minutes !== "number" || !Number.isFinite(step.minutes) || step.minutes <= 0) {
        return "Затримка має бути додатним числом хвилин";
      }
    } else {
      return "Невідомий тип кроку";
    }
  }
  return null;
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

  let funnelId: string | undefined;
  let name: string | undefined;
  let definition: unknown;
  let isActive = false;
  let deleteFunnel = false;
  try {
    const body = JSON.parse(event.body || "{}");
    funnelId = typeof body.funnelId === "string" ? body.funnelId : undefined;
    name = typeof body.name === "string" ? body.name.trim() : undefined;
    definition = body.definition;
    isActive = body.isActive === true;
    deleteFunnel = body.delete === true && typeof body.funnelId === "string";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  // Rename: an existing funnel plus a name and no definition. Lets the builder
  // change just the title without having to fetch and resend the whole
  // (linear-model) definition it never touches, and without disturbing is_active.
  const renameOnly = !deleteFunnel && !!funnelId && definition === undefined;

  if (!deleteFunnel) {
    if (!name) {
      return jsonResponse(400, { error: "Назва обов'язкова" });
    }

    if (!renameOnly) {
      const definitionError = validateDefinition(definition);
      if (definitionError) {
        return jsonResponse(400, { error: definitionError });
      }
    }
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

  if (deleteFunnel) {
    // funnel_nodes/funnel_edges/funnel_states/lead_gen_links all cascade off
    // funnels.id — a delete here also removes this funnel's graph, any active
    // enrollments in it, and any lead-gen links that point to it.
    const { error: deleteError } = await supabase.from("funnels").delete().eq("id", funnelId).eq("org_id", orgId);
    if (deleteError) {
      console.error("save-funnel: delete failed", deleteError);
      return jsonResponse(500, { error: "Не вдалося видалити воронку" });
    }
    return jsonResponse(200, { ok: true });
  }

  if (renameOnly) {
    const { data: funnel, error: renameError } = await supabase
      .from("funnels")
      .update({ name })
      .eq("id", funnelId)
      .eq("org_id", orgId)
      .select("id, name, is_active, created_at")
      .maybeSingle();

    if (renameError) {
      console.error("save-funnel: rename failed", renameError);
      return jsonResponse(500, { error: "Не вдалося перейменувати воронку" });
    }
    if (!funnel) {
      return jsonResponse(404, { error: "Воронку не знайдено" });
    }
    return jsonResponse(200, { ok: true, funnel });
  }

  if (funnelId) {
    const { data: existing, error: existingError } = await supabase
      .from("funnels")
      .select("id")
      .eq("id", funnelId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (existingError || !existing) {
      return jsonResponse(404, { error: "Воронку не знайдено" });
    }
  }

  // No exclusivity rule: any number of funnels can be active for an org at
  // once (see toggle-funnel.ts) — each lead-gen link names its own funnel_id
  // and entry_node_id explicitly, so there's no ambiguity to guard against.
  if (funnelId) {
    const { data: funnel, error: updateError } = await supabase
      .from("funnels")
      .update({ name, definition, is_active: isActive })
      .eq("id", funnelId)
      .eq("org_id", orgId)
      .select("id, name, definition, is_active, created_at")
      .single();

    if (updateError || !funnel) {
      console.error("save-funnel: update failed", updateError);
      return jsonResponse(500, { error: "Не вдалося зберегти воронку" });
    }
    return jsonResponse(200, { ok: true, funnel });
  }

  const { data: funnel, error: insertError } = await supabase
    .from("funnels")
    .insert({ org_id: orgId, name, definition, is_active: isActive })
    .select("id, name, definition, is_active, created_at")
    .single();

  if (insertError || !funnel) {
    console.error("save-funnel: insert failed", insertError);
    return jsonResponse(500, { error: "Не вдалося зберегти воронку" });
  }

  return jsonResponse(200, { ok: true, funnel });
};
