// Background-function twin of ai-respond.ts — see funnel-advance-background.ts
// for why this exists. telegram-webhook.ts's AI hand-off used to await the
// full OpenRouter round trip before it could answer Telegram at all; that
// multi-second wait (measured 7-30s depending on reply length) is exactly
// what risks a Telegram-side retry of the same update. Same handler, same
// behavior — only the invocation contract differs.
export { handler } from "./ai-respond";
