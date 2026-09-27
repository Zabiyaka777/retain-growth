import { createClient } from "@supabase/supabase-js";
import { drainDomainRemovals } from "./_shared/netlify-domains";

// Once a day: removes the Netlify domain alias of custom domains whose
// landing/link row is gone. Deletes through save-landing-page /
// save-leadgen-link already drain the queue on the spot; this catches the
// rest — cascade deletes (a funnel takes its lead-gen links with it, an
// organization takes everything) and anything a Netlify hiccup left behind.
export const handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await drainDomainRemovals(supabase);
  console.log("custom-domain-cleanup:", result ? JSON.stringify(result) : "skipped (no token / Netlify or DB error), queue kept");
  return { statusCode: 200, body: "" };
};
