// Background-function twin of funnel-advance.ts — Netlify's `-background`
// filename convention. telegram-webhook.ts fires this and gets a 202 back in
// milliseconds instead of awaiting the whole graph walk (which can include an
// AI node's opening turn, itself a full OpenRouter round trip). Netlify keeps
// this running for up to 15 minutes after the 202, regardless of whether the
// caller has already answered Telegram — unlike a plain un-awaited fetch in a
// normal function, which risks being frozen mid-flight the instant the
// caller's own handler returns (see transcribe-voice.ts's comment on that
// exact hazard). Same handler, same behavior — only the invocation contract
// differs.
export { handler } from "./funnel-advance";
