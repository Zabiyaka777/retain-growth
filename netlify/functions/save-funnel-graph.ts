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

type NodeType = "message" | "action" | "entry" | "ai" | "delay" | "condition" | "conversion";
type ActionType = "set_tag" | "set_variable" | "subscribe" | "unsubscribe" | "open_chat" | "close_chat";

interface FunnelButton {
  id: string;
  label: string;
  actionType?: "edge" | "link";
  url?: string;
}

interface InNode {
  id: string;
  type: NodeType;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

interface InEdge {
  id: string;
  from_node_id: string;
  from_button_id: string | null;
  to_node_id: string;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const VALID_ACTION_TYPES: ActionType[] = ["set_tag", "set_variable", "subscribe", "unsubscribe", "open_chat", "close_chat"];
const MESSAGE_CHAR_LIMIT = 4096;
const MESSAGE_CHAR_LIMITS: Record<"telegram" | "whatsapp" | "fbm", number> = { telegram: 4096, whatsapp: 4096, fbm: 2000 };
const CHANNEL_LABELS: Record<"telegram" | "whatsapp" | "fbm", string> = { telegram: "Telegram", whatsapp: "WhatsApp", fbm: "FB Messenger" };

type ChannelConfigLike = { text?: unknown; blocks?: { kind?: unknown; text?: unknown }[] } | null | undefined;

// The block-based editor stores text on the one text-kind block; pre-block
// saves (real, already-live data) still have it at channel.text directly —
// accept either so validation doesn't reject data the client itself still
// reads via the same fallback (see FunnelBuilder.tsx's normalizeChannelConfig).
function getChannelText(channel: ChannelConfigLike): string {
  const textBlock = Array.isArray(channel?.blocks) ? channel.blocks.find((b) => b?.kind === "text") : undefined;
  const text = textBlock ? textBlock.text : channel?.text;
  return typeof text === "string" ? text : "";
}

interface GraphValidationResult {
  error: string | null;
  // Set when the graph is savable but something about it is worth flagging —
  // currently just "no entry point at all". Never blocks the save.
  warning: string | null;
}

// Mirrors the exact validation the client already runs, re-checked here
// because the client can't be trusted.
function validateGraph(nodes: InNode[], edges: InEdge[]): GraphValidationResult {
  const entryCount = nodes.filter((n) => n.type === "entry").length;
  // Any number of entry points is valid now — each lead-gen link picks its
  // own (see lead_gen_links.entry_node_id). Zero is still allowed (e.g. a
  // work-in-progress graph), just flagged: nothing can enroll a lead into it
  // yet.
  const warning =
    entryCount === 0
      ? "Граф не має точки входу — посилання лідогенерації не зможуть запустити цей тунель, поки ви не додасте хоча б один вузол «Точка входу»."
      : null;

  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    if (node.type === "message") {
      const channels = node.config?.channels as
        | { telegram?: ChannelConfigLike; whatsapp?: ChannelConfigLike; fbm?: ChannelConfigLike }
        | undefined;
      const text = getChannelText(channels?.telegram);
      if (!text.trim()) {
        return { error: "Кожне повідомлення повинно мати текст", warning: null };
      }
      if (text.length > MESSAGE_CHAR_LIMIT) {
        return { error: `Текст повідомлення перевищує ${MESSAGE_CHAR_LIMIT} символів`, warning: null };
      }

      // Telegram is the only channel required to have text (the only one
      // that currently sends) — WhatsApp/FBM may be blank, but if filled in,
      // still can't exceed that channel's own limit.
      for (const channelKey of ["whatsapp", "fbm"] as const) {
        const channelText = getChannelText(channels?.[channelKey]);
        const limit = MESSAGE_CHAR_LIMITS[channelKey];
        if (channelText.length > limit) {
          return { error: `Текст ${CHANNEL_LABELS[channelKey]} перевищує ${limit} символів`, warning: null };
        }
      }

      const buttons = node.config?.buttons;
      if (buttons !== undefined) {
        if (!Array.isArray(buttons)) return { error: "Некоректний список кнопок", warning: null };
        for (const b of buttons as FunnelButton[]) {
          if (!b?.id || !b?.label || !String(b.label).trim()) {
            return { error: "Кожна кнопка повинна мати текст", warning: null };
          }
          if (b.actionType === "link" && !String(b.url ?? "").trim()) {
            return { error: "Кнопка-посилання повинна мати URL", warning: null };
          }
        }
      }
    } else if (node.type === "action") {
      const actionType = node.config?.action_type;
      if (typeof actionType !== "string" || !VALID_ACTION_TYPES.includes(actionType as ActionType)) {
        return { error: "Кожна дія повинна мати тип", warning: null };
      }
      const payload = (node.config?.payload as Record<string, unknown> | undefined) ?? {};
      if (actionType === "set_tag" && !String(payload.tag_id ?? "").trim()) {
        return { error: "Дія «Тег» повинна мати обраний тег", warning: null };
      }
      if (actionType === "set_variable" && !String(payload.variable_def_id ?? "").trim()) {
        return { error: "Дія «Змінна» повинна мати обрану змінну", warning: null };
      }
    } else if (node.type === "ai") {
      // Rules are optional; context is what the model can't work without.
      if (!String(node.config?.context ?? "").trim()) {
        return { error: "AI-вузол повинен мати заповнений контекст", warning: null };
      }
    } else if (node.type === "condition") {
      // Same class of check the action node gets for its own tag/variable
      // pickers: a rule pointing at nothing would silently route every lead
      // down the "Ні" branch.
      const rules = node.config?.conditions;
      if (rules !== undefined) {
        if (!Array.isArray(rules)) return { error: "Некоректний список умов", warning: null };
        for (const rule of rules as { kind?: string; tag_id?: string; variable_def_id?: string }[]) {
          if (rule?.kind === "variable") {
            if (!String(rule.variable_def_id ?? "").trim()) return { error: "Умова зі змінною повинна мати обрану змінну", warning: null };
          } else if (!String(rule?.tag_id ?? "").trim()) {
            return { error: "Умова з тегом повинна мати обраний тег", warning: null };
          }
        }
      }
    } else if (node.type === "delay") {
      // No validation: an all-zero relative delay just resumes immediately,
      // which is harmless.
    } else if (node.type === "conversion") {
      // Mirrors the client's own check: without a stage the node would walk
      // leads past it recording nothing at all.
      if (!String(node.config?.stage_id ?? "").trim()) {
        return { error: "Вузол «Логічна конверсія» повинен мати обраний етап воронки", warning: null };
      }
    } else if (node.type !== "entry") {
      return { error: "Невідомий тип вузла", warning: null };
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id)) {
      return { error: "Ребро посилається на неіснуючий вузол", warning: null };
    }
  }

  return { error: null, warning };
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
  let nodes: InNode[] | undefined;
  let edges: InEdge[] | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    funnelId = typeof body.funnelId === "string" ? body.funnelId : undefined;
    nodes = Array.isArray(body.nodes) ? body.nodes : undefined;
    edges = Array.isArray(body.edges) ? body.edges : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!funnelId || !nodes || !edges) {
    return jsonResponse(400, { error: "funnelId, nodes і edges обов'язкові" });
  }

  const { error: validationError, warning } = validateGraph(nodes, edges);
  if (validationError) {
    return jsonResponse(400, { error: validationError });
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

  const { data: funnel, error: funnelError } = await supabase
    .from("funnels")
    .select("id")
    .eq("id", funnelId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (funnelError || !funnel) {
    return jsonResponse(404, { error: "Воронку не знайдено" });
  }

  // Delete nodes that were removed on the canvas — funnel_edges FK is
  // ON DELETE CASCADE, so this also cleans up any edges attached to them.
  const { data: existingNodes } = await supabase.from("funnel_nodes").select("id").eq("funnel_id", funnelId);
  const incomingNodeIds = new Set(nodes.map((n) => n.id));
  const nodeIdsToDelete = (existingNodes ?? []).map((n) => n.id).filter((id) => !incomingNodeIds.has(id));
  if (nodeIdsToDelete.length > 0) {
    await supabase.from("funnel_nodes").delete().in("id", nodeIdsToDelete);
  }

  if (nodes.length > 0) {
    const { error: nodesUpsertError } = await supabase.from("funnel_nodes").upsert(
      nodes.map((n) => ({
        id: n.id,
        funnel_id: funnelId,
        type: n.type,
        config: n.config,
        position: n.position,
      })),
      { onConflict: "id" },
    );

    if (nodesUpsertError) {
      console.error("save-funnel-graph: nodes upsert failed", nodesUpsertError);
      return jsonResponse(500, { error: "Не вдалося зберегти вузли" });
    }
  }

  // Edges belonging to this funnel = edges whose from_node_id is one of this
  // funnel's nodes (funnel_edges carries no funnel_id of its own).
  const { data: existingEdges } = await supabase
    .from("funnel_edges")
    .select("id, from_node_id")
    .in("from_node_id", nodes.map((n) => n.id));
  const incomingEdgeIds = new Set(edges.map((e) => e.id));
  const edgeIdsToDelete = (existingEdges ?? []).map((e) => e.id).filter((id) => !incomingEdgeIds.has(id));
  if (edgeIdsToDelete.length > 0) {
    await supabase.from("funnel_edges").delete().in("id", edgeIdsToDelete);
  }

  if (edges.length > 0) {
    const { error: edgesUpsertError } = await supabase.from("funnel_edges").upsert(
      edges.map((e) => ({
        id: e.id,
        from_node_id: e.from_node_id,
        from_button_id: e.from_button_id,
        to_node_id: e.to_node_id,
      })),
      { onConflict: "id" },
    );

    if (edgesUpsertError) {
      console.error("save-funnel-graph: edges upsert failed", edgesUpsertError);
      return jsonResponse(500, { error: "Не вдалося зберегти з'єднання" });
    }
  }

  return jsonResponse(200, { ok: true, warning });
};
