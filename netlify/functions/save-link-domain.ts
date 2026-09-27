import { makeSaveDomainHandler } from "./_shared/netlify-domains";

// Attaches/detaches the custom domain of a lead-gen link — shared with the other entity
// type, see _shared/netlify-domains.ts.
export const handler = makeSaveDomainHandler("link");
