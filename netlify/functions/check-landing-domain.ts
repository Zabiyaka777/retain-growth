import { makeCheckDomainHandler } from "./_shared/netlify-domains";

// Verifies DNS/SSL for the custom domain of a landing page — shared with the other entity
// type, see _shared/netlify-domains.ts.
export const handler = makeCheckDomainHandler("landing");
