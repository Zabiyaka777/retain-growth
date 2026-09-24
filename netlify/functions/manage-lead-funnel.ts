import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logLeadActivity } from "./_shared/activity-log";

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

type Action = "move" | "stop" | "attach";

const STATE_COLUMNS = "id, thread_id, funnel_id, funnel_node_id, status, waiting_until";

const NODE_TYPE_LABELS: Record<string, string> = {
  entry: "Точка входу",
  message: "Повідомлення",
  action: "Дія",
  ai: "AI",
  delay: "Затримка",
  condition: "Умова",
  conversion: "Логічна конверсія",
};

/**
 * Resolves the human-readable pieces the activity log needs: which lead the
 * state belongs to (it's keyed by thread), and the funnel/node names as they
 * read right now.
 */
async function describeState(
  supabase: SupabaseClient,
  threadId: string,
  funnelId: string,
  nodeId: string | null,
): Promise<{ leadId: string | null; funnelName: string | null; nodeLabel: string | null }> {
  const [threadRes, funnelRes, nodeRes] = await Promise.all([
    supabase.from("threads").select("lead_id").eq("id", threadId).maybeSingle(),
    supabase.from("funnels").select("name").eq("id", funnelId).maybeSingle(),
    nodeId
      ? supabase.from("funnel_nodes").select("type, config").eq("id", nodeId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const node = nodeRes.data as { type?: string; config?: { label?: string } | null } | null;
  const custom = node?.config?.label?.trim();
  const typeLabel = node?.type ? (NODE_TYPE_LABELS[node.type] ?? node.type) : null;

  return {
    leadId: (threadRes.data?.lead_id as string | undefined) ?? null,
    funnelName: (funnelRes.data?.name as string | undefined) ?? null,
    nodeLabel: custom || typeLabel,
  };
}

/**
 * Hands a just-moved/attached state to funnel-advance-background so the node
 * runs now instead of on the next cron pass (up to a minute later) — same
 * call telegram-webhook.ts makes after an enrollment ("Advance immediately
 * rather than waiting"). Safe alongside the cron: funnel-advance goes through
 * claim_specific_funnel_state, which leases the row atomically, so whichever
 * of the two gets there first runs the node and the other finds nothing.
 * Failure is only logged — the state is already active and due, so the cron
 * still picks it up.
 */
async function advanceNow(stateId: string) {
  const siteUrl = process.env.URL;
  if (!siteUrl) return;
  try {
    await fetch(`${siteUrl}/.netlify/functions/funnel-advance-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The lead was placed on this node a moment ago — a delay here must
      // start counting now, not be treated as already waited out.
      body: JSON.stringify({ stateId, freshPlacement: true }),
    });
  } catch (err) {
    console.error("manage-lead-funnel: funnel-advance invoke failed", err);
  }
}

/**
 * Manual control over where a lead sits in a funnel — the operator's escape
 * hatch when a lead is stuck on a node waiting for a button that will never
 * be tapped.
 *
 * It only moves the marker; the node itself is executed by the normal
 * funnel-advance path (see advanceNow), never inline here.
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

  let action: Action | undefined;
  let stateId: string | undefined;
  let threadId: string | undefined;
  let funnelId: string | undefined;
  let nodeId: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    action = ["move", "stop", "attach"].includes(body.action) ? (body.action as Action) : undefined;
    stateId = typeof body.stateId === "string" ? body.stateId : undefined;
    threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    funnelId = typeof body.funnelId === "string" ? body.funnelId : undefined;
    nodeId = typeof body.nodeId === "string" ? body.nodeId : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!action) {
    return jsonResponse(400, { error: "Невідома дія" });
  }

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request body (see CLAUDE.md: org_id scoping).
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

  // ---- stop: the lead simply stops moving ----
  // status='stopped' rather than deleting the row: the CHECK already allows
  // it, the cron's claim only ever looks at 'active', and keeping the row
  // preserves which funnel and node the lead was on. Deleting would also
  // free the (thread_id, funnel_id) unique slot, quietly turning a later
  // re-attach into a brand-new run with no trace of the first.
  if (action === "stop") {
    if (!stateId) return jsonResponse(400, { error: "stateId обов'язковий" });

    const { data: stopped, error } = await supabase
      .from("funnel_states")
      .update({ status: "stopped" })
      .eq("id", stateId)
      .eq("org_id", orgId)
      .select(STATE_COLUMNS);

    if (error) {
      console.error("manage-lead-funnel: stop failed", error);
      return jsonResponse(500, { error: "Не вдалося зупинити воронку" });
    }
    if (!stopped || stopped.length === 0) {
      return jsonResponse(404, { error: "Стан воронки не знайдено" });
    }

    const stoppedState = stopped[0];
    const info = await describeState(
      supabase,
      stoppedState.thread_id as string,
      stoppedState.funnel_id as string,
      (stoppedState.funnel_node_id as string | null) ?? null,
    );
    if (info.leadId) {
      await logLeadActivity(supabase, {
        orgId,
        leadId: info.leadId,
        actionType: "funnel_stopped",
        actorType: "manager",
        actorUserId: userData.user.id,
        actorEmail: userData.user.email,
        details: { funnel_name: info.funnelName, node_label: info.nodeLabel },
      });
    }

    return jsonResponse(200, { ok: true, state: stoppedState });
  }

  // ---- move: reposition inside the funnel the lead is already in ----
  if (action === "move") {
    if (!stateId || !nodeId) return jsonResponse(400, { error: "stateId і nodeId обов'язкові" });

    const { data: state, error: stateError } = await supabase
      .from("funnel_states")
      .select("id, funnel_id")
      .eq("id", stateId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (stateError || !state) {
      return jsonResponse(404, { error: "Стан воронки не знайдено" });
    }

    // The node must belong to this state's own funnel — funnel_node_id has a
    // FK to funnel_nodes but nothing ties it to funnel_id, so a node from
    // another funnel would be accepted by the database and leave the walk
    // resolving edges that lead nowhere.
    const { data: node, error: nodeError } = await supabase
      .from("funnel_nodes")
      .select("id, funnel_id")
      .eq("id", nodeId)
      .maybeSingle();

    if (nodeError || !node || node.funnel_id !== state.funnel_id) {
      return jsonResponse(404, { error: "Вузол не знайдено в цій воронці" });
    }

    // waiting_until = now() makes the state due for the normal claim query;
    // advanceNow below then runs the node right away, exactly as it would
    // have if the lead had arrived here on their own.
    const { data: moved, error: updateError } = await supabase
      .from("funnel_states")
      .update({ funnel_node_id: nodeId, status: "active", waiting_until: new Date().toISOString() })
      .eq("id", stateId)
      .eq("org_id", orgId)
      .select(STATE_COLUMNS);

    if (updateError) {
      console.error("manage-lead-funnel: move failed", updateError);
      return jsonResponse(500, { error: "Не вдалося перемкнути вузол" });
    }

    const movedState = moved?.[0] ?? null;
    if (movedState) {
      await advanceNow(movedState.id as string);
      const info = await describeState(supabase, movedState.thread_id as string, state.funnel_id as string, nodeId);
      if (info.leadId) {
        await logLeadActivity(supabase, {
          orgId,
          leadId: info.leadId,
          actionType: "funnel_switched",
          actorType: "manager",
          actorUserId: userData.user.id,
          actorEmail: userData.user.email,
          details: { funnel_name: info.funnelName, node_label: info.nodeLabel },
        });
      }
    }

    return jsonResponse(200, { ok: true, state: movedState });
  }

  // ---- attach: put a lead into a funnel by hand ----
  if (!threadId || !funnelId || !nodeId) {
    return jsonResponse(400, { error: "threadId, funnelId і nodeId обов'язкові" });
  }

  const { data: thread, error: threadError } = await supabase
    .from("threads")
    .select("id")
    .eq("id", threadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (threadError || !thread) {
    return jsonResponse(404, { error: "Тред не знайдено" });
  }

  const { data: funnel, error: funnelError } = await supabase
    .from("funnels")
    .select("id")
    .eq("id", funnelId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (funnelError || !funnel) {
    return jsonResponse(404, { error: "Воронку не знайдено" });
  }

  // Any node may be the starting point, not just an entry node — that's the
  // point of a manual attach. It must still belong to the chosen funnel.
  const { data: startNode, error: startNodeError } = await supabase
    .from("funnel_nodes")
    .select("id, funnel_id")
    .eq("id", nodeId)
    .maybeSingle();
  if (startNodeError || !startNode || startNode.funnel_id !== funnelId) {
    return jsonResponse(404, { error: "Вузол не знайдено в цій воронці" });
  }

  // Same upsert the webhook enrollment uses, on the same (thread_id,
  // funnel_id) unique key — so re-attaching to a funnel the lead already
  // ran restarts it rather than colliding. leads.source_link_id and
  // source_click_id are deliberately untouched: a manual attach is not an
  // ad click and must not rewrite where the lead actually came from.
  const { data: state, error: upsertError } = await supabase
    .from("funnel_states")
    .upsert(
      {
        thread_id: threadId,
        org_id: orgId,
        funnel_id: funnelId,
        funnel_node_id: nodeId,
        status: "active",
        current_step: 0,
        waiting_until: new Date().toISOString(),
        ai_progress: null,
      },
      { onConflict: "thread_id,funnel_id" },
    )
    .select(STATE_COLUMNS)
    .single();

  if (upsertError || !state) {
    console.error("manage-lead-funnel: attach failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося підключити до воронки" });
  }

  await advanceNow(state.id as string);

  const info = await describeState(supabase, threadId, funnelId, nodeId);
  if (info.leadId) {
    await logLeadActivity(supabase, {
      orgId,
      leadId: info.leadId,
      actionType: "funnel_connected",
      actorType: "manager",
      actorUserId: userData.user.id,
      actorEmail: userData.user.email,
      details: { funnel_name: info.funnelName, node_label: info.nodeLabel },
    });
  }

  return jsonResponse(200, { ok: true, state });
};
