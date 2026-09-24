// One-off: re-points every connected Telegram bot's webhook at a new app origin.
//
// Needed whenever the app's primary domain changes: connect-telegram.ts bakes
// process.env.URL into the webhook URL at connect time, and Telegram keeps
// calling that stored URL forever — it never follows the domain move itself.
//
// The webhook contract (see connect-telegram.ts / telegram-webhook.ts):
//   url          = <origin>/.netlify/functions/telegram-webhook/<org_id>
//   secret_token = Vault secret behind channel_credentials.webhook_secret_id
// Both are mandatory. setWebhook without secret_token CLEARS the stored one,
// and telegram-webhook.ts then silently drops every update as a mismatch.
// The existing secret is re-sent as-is, so nothing in the DB changes.
//
// WhatsApp (none connected as of this migration): its callback URL is also
// per-org (<origin>/.netlify/functions/whatsapp-webhook/<org_id>) but is
// registered on Meta's side, not through an API call we own — after a domain
// move each org's callback URL has to be re-saved via whatsapp-connect.ts /
// the Meta app dashboard. This script does not touch it.
//
// Usage (env comes from the linked Netlify site, never printed):
//   netlify dev:exec node scripts/migrate-telegram-webhooks.mjs                    # dry run
//   APPLY=1 netlify dev:exec node scripts/migrate-telegram-webhooks.mjs
//   ORIGIN=https://some-other-host APPLY=1 netlify dev:exec node scripts/...       # override target
// (env switches, not flags: `netlify dev:exec` swallows unknown --options itself.)

import { createClient } from "@supabase/supabase-js";
import { WebSocket as NodeWebSocket } from "ws";

if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = NodeWebSocket;

const apply = process.env.APPLY === "1";
const origin = (process.env.ORIGIN || "https://app.retain-growth.ai").replace(/\/$/, "");

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — run through `netlify dev:exec`.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function tg(botToken, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

const { data: rows, error } = await supabase
  .from("channel_credentials")
  .select("org_id, bot_token_secret_id, webhook_secret_id")
  .eq("channel_type", "telegram");

if (error) {
  console.error("channel_credentials query failed", error);
  process.exit(1);
}

console.log(`${apply ? "APPLY" : "DRY RUN"} · target origin ${origin} · ${rows.length} telegram credential(s)\n`);

let failed = 0;
for (const row of rows) {
  const target = `${origin}/.netlify/functions/telegram-webhook/${row.org_id}`;
  const [{ data: botToken }, { data: secret }] = await Promise.all([
    supabase.rpc("vault_read_secret", { secret_id: row.bot_token_secret_id }),
    row.webhook_secret_id ? supabase.rpc("vault_read_secret", { secret_id: row.webhook_secret_id }) : { data: null },
  ]);

  if (!botToken || !secret) {
    console.error(`org ${row.org_id}: SKIPPED — ${!botToken ? "bot token" : "webhook secret"} unreadable from Vault`);
    failed++;
    continue;
  }

  const [me, before] = await Promise.all([tg(botToken, "getMe"), tg(botToken, "getWebhookInfo")]);
  const label = `org ${row.org_id} (@${me.result?.username ?? "?"})`;
  console.log(`${label}\n  current: ${before.result?.url || "(none)"}  pending=${before.result?.pending_update_count ?? "?"}` +
    (before.result?.last_error_message ? `  last_error="${before.result.last_error_message}"` : ""));
  console.log(`  target:  ${target}`);

  if (before.result?.url === target) { console.log("  already migrated\n"); continue; }
  if (!apply) { console.log("  (dry run — not changed)\n"); continue; }

  // drop_pending_updates stays false: anything a lead sent during the switch must still be delivered.
  const set = await tg(botToken, "setWebhook", { url: target, secret_token: secret, drop_pending_updates: false });
  const after = await tg(botToken, "getWebhookInfo");
  if (!set.ok || after.result?.url !== target) {
    console.error(`  FAILED: ${set.description ?? "url did not change"}\n`);
    failed++;
    continue;
  }
  console.log(`  ok → ${after.result.url}\n`);
}

process.exit(failed ? 1 : 0);
