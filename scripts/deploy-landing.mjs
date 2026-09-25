#!/usr/bin/env node
// The only way to deploy the marketing landing (retain-growth.ai).
//
// Why a script: the landing is a separate Netlify site built from the same
// repo, and twice now a landing deploy picked up the app's functions — once
// from a bad `functions` path, once from the CLI's functions cache right after
// an app deploy — and published all of them on retain-growth.ai. Remembering
// the right flags didn't prevent the second time, so this makes it
// structural:
//
//   1. refuse to run with uncommitted changes in landing/ (CLAUDE.md: no
//      deploy without a commit);
//   2. deploy a DRAFT with the safe flags (--functions ../no-functions
//      --skip-functions-cache);
//   3. probe every app function name on the draft URL — anything but 404
//      means functions leaked, and the draft is never published;
//   4. publish that exact draft (no rebuild) and probe again on
//      retain-growth.ai, plus a smoke test of the page and the /r/ and /lp/
//      redirects. A failure here exits non-zero with the rollback command.
//
// Usage: npm run deploy:landing            (from the repo root)
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANDING_DIR = join(ROOT, "landing");
const SITE_ID = "d9c578f7-c838-40d2-91f6-8392f382e2bc";
const PROD = "https://retain-growth.ai";
const APP = "https://app.retain-growth.ai";

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
function fail(msg) {
  console.error(red(`✖ ${msg}`));
  process.exit(1);
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

// Every function the app ships — read from disk, so a new function is
// covered the day it's added.
const FUNCTIONS = readdirSync(join(ROOT, "netlify/functions"))
  .filter((f) => /\.(ts|js|mjs)$/.test(f))
  .map((f) => f.replace(/\.(ts|js|mjs)$/, ""));

async function probeFunctions(base) {
  const leaked = [];
  let next = 0;
  async function worker() {
    while (next < FUNCTIONS.length) {
      const name = FUNCTIONS[next++];
      try {
        const res = await fetch(`${base}/.netlify/functions/${name}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15000) });
        if (res.status !== 404) leaked.push(`${name} → ${res.status}`);
      } catch (err) {
        // Can't prove it's absent — treat as a failure, not a pass.
        leaked.push(`${name} → ${err.name === "TimeoutError" ? "timeout" : "network error"}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return leaked;
}

async function expectStatus(url, want, locationPrefix) {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  const loc = res.headers.get("location") ?? "";
  if (res.status !== want || (locationPrefix && !loc.startsWith(locationPrefix))) {
    return `${url} → ${res.status}${loc ? ` (${loc})` : ""}, expected ${want}${locationPrefix ? ` → ${locationPrefix}…` : ""}`;
  }
  return null;
}

// 1. committed?
const dirty = sh("git", ["status", "--porcelain", "--", "landing", "no-functions"]).trim();
if (dirty) fail(`Незакомічені зміни в landing/ — спершу коміт (CLAUDE.md):\n${dirty}`);
const sha = sh("git", ["rev-parse", "--short", "HEAD"]).trim();

// 2. draft
console.log(`→ Draft deploy of landing @ ${sha} (${FUNCTIONS.length} app functions to check)…`);
let deploy;
try {
  const out = sh("netlify", ["deploy", "--site", SITE_ID, "--dir", ".", "--no-build", "--functions", "../no-functions", "--skip-functions-cache", "--json", "--message", `landing ${sha}`], { cwd: LANDING_DIR });
  deploy = JSON.parse(out.slice(out.indexOf("{")));
} catch (err) {
  fail(`Draft deploy failed:\n${err.stderr || err.message}`);
}
const draftUrl = deploy.deploy_url;
if (!deploy.deploy_id || !draftUrl) fail(`Unexpected deploy output: ${JSON.stringify(deploy)}`);
console.log(`  draft: ${draftUrl}`);

// 3. no functions on the draft
const leakedDraft = await probeFunctions(draftUrl);
if (leakedDraft.length) {
  fail(`App functions answer on the DRAFT — not publishing.\n  ${leakedDraft.join("\n  ")}\nProduction is untouched.`);
}
console.log(green(`  ✓ draft: all ${FUNCTIONS.length} function paths → 404`));

// 4. publish exactly this deploy, then verify production
const before = JSON.parse(sh("netlify", ["api", "listSiteDeploys", "--data", JSON.stringify({ site_id: SITE_ID, per_page: 5 })]))
  .find((d) => d.published_at && d.id !== deploy.deploy_id);
sh("netlify", ["api", "restoreSiteDeploy", "--data", JSON.stringify({ site_id: SITE_ID, deploy_id: deploy.deploy_id })]);
console.log(`→ Published ${deploy.deploy_id}. Verifying ${PROD}…`);
await new Promise((r) => setTimeout(r, 3000));

const problems = [
  ...(await probeFunctions(PROD)),
  await expectStatus(`${PROD}/`, 200),
  await expectStatus(`${PROD}/r/deploy-check?ch=telegram`, 302, `${APP}/r/`),
  await expectStatus(`${PROD}/lp/deploy-check`, 302, `${APP}/lp/`),
].filter(Boolean);

if (problems.length) {
  const rollback = before
    ? `netlify api restoreSiteDeploy --data '${JSON.stringify({ site_id: SITE_ID, deploy_id: before.id })}'`
    : "(no earlier published deploy found — roll back in the Netlify UI)";
  fail(`Production check failed:\n  ${problems.join("\n  ")}\nRoll back to the previous deploy:\n  ${rollback}`);
}
console.log(green(`✓ Landing live at ${PROD}: no app functions, page 200, /r/ and /lp/ redirect to the app.`));
