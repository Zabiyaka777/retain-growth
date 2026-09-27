import { makeCheckDomainHandler } from "./_shared/netlify-domains";

// Verifies DNS/SSL for the custom domain of a lead-gen link — shared with the other entity
// type, see _shared/netlify-domains.ts.
export const handler = makeCheckDomainHandler("link");
