import { supabase } from './supabaseClient'

// PushManager.subscribe() wants applicationServerKey as a Uint8Array, not the
// base64url string VAPID keys are normally handed around as.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function callSavePushSubscription(body: Record<string, unknown>) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Не авторизовано')

  const res = await fetch('/.netlify/functions/save-push-subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    throw new Error(payload.error || 'Не вдалося зберегти підписку')
  }
}

/**
 * Requests notification permission, registers the service worker, subscribes
 * to push, and saves the subscription server-side. Throws with a
 * user-readable message on any step that fails (permission denied, no
 * VAPID key configured, network error) — the caller decides how to surface it.
 */
export async function enablePushNotifications(): Promise<void> {
  if (!isPushSupported()) throw new Error('Цей браузер не підтримує push-сповіщення')

  const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (!publicKey) throw new Error('VAPID-ключ не сконфігуровано')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Дозвіл на сповіщення не надано')

  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  }

  const json = subscription.toJSON()
  await callSavePushSubscription({
    action: 'subscribe',
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  })
}

/** Unsubscribes this browser both locally and server-side. */
export async function disablePushNotifications(): Promise<void> {
  if (!isPushSupported()) return

  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return

  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  await callSavePushSubscription({ action: 'unsubscribe', endpoint })
}

/** Whether this browser currently holds an active push subscription. */
export async function isPushEnabled(): Promise<boolean> {
  if (!isPushSupported()) return false
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  if (!registration) return false
  const subscription = await registration.pushManager.getSubscription()
  return !!subscription
}
