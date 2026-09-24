import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { randomUUID } from "node:crypto";
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
  try {
    const body = JSON.parse(event.body || "{}");
    funnelId = typeof body.funnelId === "string" ? body.funnelId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!funnelId) {
    return jsonResponse(400, { error: "funnelId обов'язковий" });
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

  const { data: source, error: sourceError } = await supabase
    .from("funnels")
    .select("id, name, definition")
    .eq("id", funnelId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (sourceError || !source) {
    return jsonResponse(404, { error: "Воронку не знайдено" });
  }

  const { data: nodes, error: nodesError } = await supabase
    .from("funnel_nodes")
    .select("id, type, config, position")
    .eq("funnel_id", funnelId);

  if (nodesError) {
    console.error("duplicate-funnel: nodes lookup failed", nodesError);
    return jsonResponse(500, { error: "Не вдалося прочитати вузли воронки" });
  }

  const { data: edges, error: edgesError } = await supabase
    .from("funnel_edges")
    .select("id, from_node_id, from_button_id, to_node_id")
    .in("from_node_id", (nodes ?? []).map((n) => n.id));

  if (edgesError) {
    console.error("duplicate-funnel: edges lookup failed", edgesError);
    return jsonResponse(500, { error: "Не вдалося прочитати з'єднання воронки" });
  }

  // is_active: false — a fresh copy shouldn't start receiving live
  // enrollments before its owner has had a chance to review/edit it.
  const { data: newFunnel, error: funnelInsertError } = await supabase
    .from("funnels")
    .insert({ org_id: orgId, name: `${source.name} (копія)`, definition: source.definition, is_active: false })
    .select("id, name, is_active, created_at")
    .single();

  if (funnelInsertError || !newFunnel) {
    console.error("duplicate-funnel: funnel insert failed", funnelInsertError);
    return jsonResponse(500, { error: "Не вдалося дублювати воронку" });
  }

  // Button ids inside node.config are opaque strings scoped to that node's
  // own config, not FK references — copying config verbatim keeps
  // from_button_id below valid without needing its own remap.
  const nodeIdMap = new Map<string, string>();
  for (const node of nodes ?? []) {
    nodeIdMap.set(node.id, randomUUID());
  }

  if ((nodes ?? []).length > 0) {
    const { error: nodesInsertError } = await supabase.from("funnel_nodes").insert(
      (nodes ?? []).map((n) => ({
        id: nodeIdMap.get(n.id),
        funnel_id: newFunnel.id,
        type: n.type,
        config: n.config,
        position: n.position,
      })),
    );

    if (nodesInsertError) {
      console.error("duplicate-funnel: nodes insert failed", nodesInsertError);
      await supabase.from("funnels").delete().eq("id", newFunnel.id);
      return jsonResponse(500, { error: "Не вдалося дублювати вузли воронки" });
    }
  }

  if ((edges ?? []).length > 0) {
    const { error: edgesInsertError } = await supabase.from("funnel_edges").insert(
      (edges ?? []).map((e) => ({
        id: randomUUID(),
        from_node_id: nodeIdMap.get(e.from_node_id),
        from_button_id: e.from_button_id,
        to_node_id: nodeIdMap.get(e.to_node_id),
      })),
    );

    if (edgesInsertError) {
      console.error("duplicate-funnel: edges insert failed", edgesInsertError);
      await supabase.from("funnels").delete().eq("id", newFunnel.id);
      return jsonResponse(500, { error: "Не вдалося дублювати з'єднання воронки" });
    }
  }

  return jsonResponse(200, { ok: true, funnel: newFunnel });
};
