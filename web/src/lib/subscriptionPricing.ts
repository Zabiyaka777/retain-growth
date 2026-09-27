// Subscriber-based pricing for an 'active' org. Deliberately duplicated byte-
// for-byte in netlify/functions/_shared/subscriptionPricing.ts — the client
// bundle and the functions bundle are two separate builds, and importing
// across that boundary isn't practical here, so both copies must be kept in
// sync by hand whenever the formula changes.
//
// The plan is one all-encompassing package now — no separate paid modules
// (whatsapp_fbm / ai_agent / meta_capi / pro_analytics / unlimited_funnels
// were retired; every feature is available unconditionally to an 'active'
// org). Only two things move the price:
//   - subscriber count: $29 flat covers up to 2 500 subscribers, then every
//     additional 1 000 (rounded UP — subscriber #2 501 alone already crosses
//     into the next $5 tier) adds $5/month.
//   - manager seats: $5/month each, flat, no free included seats. This is
//     still the 'extra_seat' billing_addons row/org_billing_addons quantity
//     under the hood (same table, same stepper UI) — only its price is now
//     "every seat", not "seats beyond some free count".
// org_discounts (a % off the resulting gross) is applied by the caller, not
// in here — this function only ever returns the pre-discount gross.
const BASE_PRICE = 29;
const BASE_SUBSCRIBER_LIMIT = 2500;
const PRICE_PER_EXTRA_THOUSAND = 5;
const PRICE_PER_SEAT = 5;

export function calcSubscriptionPrice(subscriberCount: number, managerSeats: number): number {
  const subscribers = Math.max(0, Math.floor(subscriberCount) || 0);
  const seats = Math.max(0, Math.floor(managerSeats) || 0);
  const over = Math.max(0, subscribers - BASE_SUBSCRIBER_LIMIT);
  const extraThousands = Math.ceil(over / 1000);
  return BASE_PRICE + extraThousands * PRICE_PER_EXTRA_THOUSAND + seats * PRICE_PER_SEAT;
}
