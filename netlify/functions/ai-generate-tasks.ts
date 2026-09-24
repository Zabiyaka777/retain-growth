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

// Test-only override, mirrored in ai-respond.ts.
//
// Deliberately NOT named OPENROUTER_BASE_URL: Netlify's AI Gateway injects
// that name (alongside OPENAI_BASE_URL / ANTHROPIC_BASE_URL) into every
// function at runtime, pointing at <site>/.netlify/ai. Reading it silently
// redirected every call to the gateway, which answers 401 with an empty body.
// Only localhost values are honoured, so no injected or stray value can ever
// point real API traffic somewhere else again.
function resolveOpenRouterBaseUrl(): string {
  const override = process.env.RG_OPENROUTER_BASE_URL;
  if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(override)) return override;
  return "https://openrouter.ai/api/v1";
}

const OPENROUTER_BASE_URL = resolveOpenRouterBaseUrl();

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
// 1024 was not enough: twelve task descriptions in Ukrainian (a token-hungry
// language) routinely ran past it, and the model's reply came back cut off
// mid-word — which the parser could only report as "unreadable format".
//
// 4096 traded that for a worse failure: generation then ran long enough to hit
// the platform's function timeout, and the caller saw a bogus "network error".
// 2048 is double the old budget — comfortably past where the truncations were
// happening — while keeping a full generation inside the time limit.
const MAX_TOKENS = 2048;

// A Netlify synchronous function is killed at 26s (30s in local dev), and a
// killed function answers with a plain-text 500 that no caller can interpret.
// Aborting first keeps the failure ours to describe.
const OPENROUTER_TIMEOUT_MS = 20000;
// Enough for a useful checklist without letting a chatty model flood the node.
const MAX_TASKS = 12;

const SYSTEM_PROMPT = [
  "Ти — помічник, який проєктує сценарії для AI-агента, що веде діалог з лідом у месенджері.",
  "Розбий надану задачу на впорядкований список конкретних, перевірюваних завдань для цього агента.",
  "Кожне завдання — одна коротка дія, сформульована так, щоб агент міг однозначно зрозуміти, коли вона виконана.",
  "Відповідай ВИКЛЮЧНО JSON-масивом без пояснень і без markdown-огорожі,",
  'у форматі: [{"description": "..."}]',
].join(" ");

// OpenRouter returns {error:{message,code}} on failure. The status alone is
// rarely enough to act on, so the provider's own message is kept and the
// common cases get an actionable prefix.
export function describeOpenRouterError(status: number, rawBody: string): string {
  let providerMessage = "";
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    providerMessage = parsed.error?.message ?? "";
  } catch {
    providerMessage = rawBody.slice(0, 200);
  }

  const prefix =
    status === 401 || status === 403
      ? "OpenRouter відхилив ключ"
      : status === 402
        ? "На балансі OpenRouter недостатньо коштів"
        : status === 404
          ? "OpenRouter не знає такої моделі — перевірте назву у полі «Модель»"
          : status === 429
            ? "OpenRouter обмежив частоту запитів, спробуйте за хвилину"
            : status >= 500
              ? "Провайдер моделі тимчасово недоступний"
              : `OpenRouter повернув помилку (${status})`;

  return providerMessage ? `${prefix}: ${providerMessage}` : prefix;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Models routinely wrap JSON in prose or a ```json fence despite being told
// not to, so pull out the first bracketed array rather than trusting the whole
// body to parse. Accepts [{description}] and a bare ["..."] list.
/**
 * Last resort for a reply that isn't valid JSON as a whole — in practice, one
 * the model didn't finish writing. Picks out the entries that are complete and
 * ignores the truncated tail.
 */
function salvageTasks(text: string): string[] {
  // Complete {...} objects only; the half-written one at the end has no
  // closing brace and so never matches.
  const objects = text.match(/\{[^{}]*\}/g) ?? [];
  const fromObjects: string[] = [];
  for (const chunk of objects) {
    try {
      const parsed = JSON.parse(chunk) as { description?: unknown };
      if (typeof parsed.description === "string" && parsed.description.trim()) {
        fromObjects.push(parsed.description.trim());
      }
    } catch {
      // A malformed entry mid-list shouldn't cost us the valid ones.
    }
  }
  if (fromObjects.length > 0) return fromObjects.slice(0, MAX_TASKS);

  // Bare ["...", "..."] list. Only when there are no braces anywhere: inside
  // an object list this would also match the "description" keys themselves.
  if (text.includes("{")) return [];

  const strings = text.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  return strings
    .map((s) => {
      try {
        return JSON.parse(s) as string;
      } catch {
        return "";
      }
    })
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_TASKS);
}

export function parseGeneratedTasks(raw: string): string[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  // No closing bracket at all — the reply stopped mid-array. Whatever whole
  // entries did arrive are still useful, so they're recovered rather than
  // discarded along with the incomplete tail.
  if (start === -1 || end === -1 || end <= start) return salvageTasks(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return salvageTasks(text);
  }
  if (!Array.isArray(parsed)) return salvageTasks(text);

  return parsed
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { description?: unknown }).description === "string") {
        return (item as { description: string }).description;
      }
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_TASKS);
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

  // context/rules come from the node's unsaved editor state, not the DB — the
  // whole point is generating before the funnel is saved.
  let context = "";
  let rules = "";
  let model = "";
  try {
    const body = JSON.parse(event.body || "{}");
    context = typeof body.context === "string" ? body.context.trim() : "";
    rules = typeof body.rules === "string" ? body.rules.trim() : "";
    model = typeof body.model === "string" ? body.model.trim() : "";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!context && !rules) {
    return jsonResponse(400, { error: "Заповніть контекст або правила, щоб згенерувати завдання" });
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

  const { data: credential, error: credentialError } = await supabase
    .from("ai_credentials")
    .select("api_key_secret_id")
    .eq("org_id", orgId)
    .maybeSingle();

  if (credentialError || !credential) {
    return jsonResponse(424, { error: "Спочатку підключіть OpenRouter у Налаштуваннях" });
  }

  const { data: apiKey, error: keyError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.api_key_secret_id,
  });

  if (keyError || !apiKey) {
    console.error("ai-generate-tasks: failed to decrypt api key", keyError);
    return jsonResponse(500, { error: "Не вдалося прочитати AI-ключ" });
  }

  const userPrompt = [context ? `## Контекст\n${context}` : "", rules ? `## Правила\n${rules}` : ""]
    .filter(Boolean)
    .join("\n\n");

  let content = "";
  // Captured for diagnosis: without these, a failed generation left no record
  // of which model answered or why it stopped — the exact gap that made this
  // bug take a log-dive to explain.
  let finishReason = "";
  let resolvedModel = model || DEFAULT_MODEL;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-Title": "Retain Growth",
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("ai-generate-tasks: OpenRouter error", res.status, detail);
      // Surface what OpenRouter actually said. The generic message this used
      // to return left the only real explanation in server logs, which are
      // invisible to whoever is clicking the button.
      return jsonResponse(502, { error: describeOpenRouterError(res.status, detail) });
    }

    const data = (await res.json()) as {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string } }[];
    };
    content = data.choices?.[0]?.message?.content ?? "";
    finishReason = data.choices?.[0]?.finish_reason ?? "";
    // OpenRouter echoes the model it actually routed to, which can differ from
    // what was asked for (aliases, :auto, provider fallbacks).
    resolvedModel = data.model || resolvedModel;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("ai-generate-tasks: OpenRouter timed out", { model: resolvedModel, ms: OPENROUTER_TIMEOUT_MS });
      return jsonResponse(504, {
        error:
          "Модель не відповіла за 20 секунд. Спробуйте ще раз, скоротіть опис задачі або оберіть швидшу модель.",
      });
    }
    console.error("ai-generate-tasks: OpenRouter call failed", err);
    return jsonResponse(502, { error: "Не вдалося зв'язатися з OpenRouter" });
  } finally {
    clearTimeout(abortTimer);
  }

  const descriptions = parseGeneratedTasks(content);
  if (descriptions.length === 0) {
    console.error("ai-generate-tasks: could not parse tasks from reply", { model: resolvedModel, finishReason }, content.slice(0, 2000));

    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "ai_tasks_unparsed",
      level: "error",
      payload: {
        model: resolvedModel,
        finish_reason: finishReason,
        // Enough to see the shape and where it stopped, without storing an
        // unbounded blob per failure.
        raw: content.slice(0, 2000),
        raw_length: content.length,
      },
    });
    if (eventError) console.error("ai-generate-tasks: events insert failed", eventError);

    // "length" means the model was still writing when it hit the token cap —
    // a different problem from an unexpected format, and a different fix for
    // whoever is clicking the button.
    if (finishReason === "length") {
      return jsonResponse(422, {
        error: "Модель не встигла дописати відповідь (вичерпано ліміт токенів). Спробуйте ще раз або скоротіть опис задачі.",
      });
    }

    return jsonResponse(422, { error: "Модель повернула відповідь, з якої не вдалося зчитати завдання" });
  }

  return jsonResponse(200, { ok: true, tasks: descriptions.map((description) => ({ description })) });
};
