import { WebSocket as NodeWebSocket } from "ws";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

// Once a day (netlify.toml): runs every SystemCheck below across all orgs and
// turns what they find into rows in `notifications` — the sidebar bell. Each
// check is independent (one failing never stops the rest) and only reports
// drafts; dedup and insert live here, once, so adding a check (an expired
// WhatsApp/Telegram token, a failing webhook, …) is one more entry in CHECKS.

interface NotificationDraft {
  orgId: string;
  source: string;
  title: string;
  body: string;
  linkUrl?: string | null;
}

interface SystemCheck {
  name: string;
  run: (supabase: SupabaseClient) => Promise<NotificationDraft[]>;
}

// An unread notification from the same source newer than this means the org
// has already been told — don't stack a second one on top every day.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------- check: OpenRouter key / credit ----------
// What a regular OpenRouter key can see about itself is GET /api/v1/key
// (connect-ai.ts's probe): its own limit/usage/limit_remaining. The account's
// real credit balance (/api/v1/credits) needs a *management* key, which orgs
// don't give us — so an unlimited key (limit: null, the default) can't be
// checked for low balance here. What we can catch: a key with a spending
// limit that's nearly used up, and a key that no longer authenticates at all.
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_LOW_BALANCE_USD = 2;

const openRouterCheck: SystemCheck = {
  name: "openrouter",
  async run(supabase) {
    const { data: creds, error } = await supabase.from("ai_credentials").select("org_id, api_key_secret_id");
    if (error) throw error;
    const drafts: NotificationDraft[] = [];
    for (const cred of creds ?? []) {
      const { data: apiKey } = await supabase.rpc("vault_read_secret", { secret_id: cred.api_key_secret_id });
      if (!apiKey) continue;
      let res: Response;
      try {
        res = await fetch(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${apiKey}` } });
      } catch (err) {
        console.error("system-notifications-check: openrouter unreachable", cred.org_id, err);
        continue; // their outage, not the org's problem — nothing to tell them
      }
      if (res.status === 401 || res.status === 403) {
        drafts.push({
          orgId: cred.org_id,
          source: "openrouter_key_invalid",
          title: "AI-ключ OpenRouter більше не працює",
          body: "OpenRouter відхиляє збережений ключ — AI-відповіді в чатах і тунелях зупинені. Перевірте ключ і за потреби підключіть новий.",
          linkUrl: "/dashboard/settings?tab=ai",
        });
        continue;
      }
      if (!res.ok) continue;
      const body = (await res.json().catch(() => null)) as { data?: { limit?: number | null; limit_remaining?: number | null; usage?: number } } | null;
      const limit = body?.data?.limit;
      if (limit == null) continue; // unlimited key — balance not visible to us (see above)
      const remaining = body?.data?.limit_remaining ?? limit - (body?.data?.usage ?? 0);
      if (remaining < OPENROUTER_LOW_BALANCE_USD) {
        drafts.push({
          orgId: cred.org_id,
          source: "openrouter_balance",
          title: "Закінчується ліміт AI-ключа",
          body: `На ключі OpenRouter лишилось $${Math.max(0, remaining).toFixed(2)} з ліміту $${limit.toFixed(2)}. Коли ліміт вичерпається, AI перестане відповідати — підвищте ліміт ключа або поповніть баланс в OpenRouter.`,
          linkUrl: "https://openrouter.ai/settings/keys",
        });
      }
    }
    return drafts;
  },
};

const CHECKS: SystemCheck[] = [openRouterCheck];

async function alreadyNotified(supabase: SupabaseClient, draft: NotificationDraft): Promise<boolean> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id")
    .eq("org_id", draft.orgId)
    .eq("source", draft.source)
    .is("read_at", null)
    .gte("created_at", new Date(Date.now() - DEDUP_WINDOW_MS).toISOString())
    .limit(1);
  if (error) {
    // Fail quiet rather than loud: a missed day beats a duplicate every run.
    console.error("system-notifications-check: dedup lookup failed", error);
    return true;
  }
  return (data ?? []).length > 0;
}

export const handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const summary: Record<string, { found: number; inserted: number } | { error: string }> = {};
  for (const check of CHECKS) {
    try {
      const drafts = await check.run(supabase);
      let inserted = 0;
      for (const d of drafts) {
        if (await alreadyNotified(supabase, d)) continue;
        const { error } = await supabase.from("notifications").insert({
          org_id: d.orgId,
          source: d.source,
          title: d.title,
          body: d.body,
          link_url: d.linkUrl ?? null,
        });
        if (error) console.error("system-notifications-check: insert failed", check.name, d.orgId, error);
        else inserted++;
      }
      summary[check.name] = { found: drafts.length, inserted };
    } catch (err) {
      console.error("system-notifications-check: check failed", check.name, err);
      summary[check.name] = { error: String(err) };
    }
  }
  console.log("system-notifications-check:", JSON.stringify(summary));
  return { statusCode: 200, body: "" };
};
