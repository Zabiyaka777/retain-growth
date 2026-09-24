// Background-function twin of send-push-notification.ts — see
// ai-respond-background.ts for why this exists. Dispatched fire-and-forget
// from telegram-webhook.ts/whatsapp-webhook.ts so a slow or unreachable push
// service never delays the webhook's own response.
export { handler } from "./send-push-notification";
