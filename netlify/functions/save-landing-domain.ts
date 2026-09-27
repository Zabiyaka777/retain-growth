import { makeSaveDomainHandler } from "./_shared/netlify-domains";

// Attaches/detaches the custom domain of a landing page — shared with the other entity
// type, see _shared/netlify-domains.ts.
export const handler = makeSaveDomainHandler("landing");
