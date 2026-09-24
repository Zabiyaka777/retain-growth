// A short synthetic blip for new inbound messages. No audio file: two quick
// tones through the Web Audio API keep it small, instant, and immune to a
// missing/blocked asset.
//
// Triangle wave, not sine: a pure sine at these short durations reads as a
// flat, percussive double-click — close enough to a camera shutter that
// users didn't recognize it as a notification. Triangle has the same clean,
// non-buzzy character but a rounder, warmer overtone that sits closer to a
// typical messenger "pop" chime. The two tones also now overlap slightly
// (legato) instead of leaving a gap, which is what read as "click-click"
// before.

let ctx: AudioContext | null = null

function getContext(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    ctx = new Ctor()
    return ctx
  } catch {
    return null
  }
}

function tone(context: AudioContext, frequency: number, startAt: number, duration: number) {
  const osc = context.createOscillator()
  const gain = context.createGain()

  osc.type = 'triangle'
  osc.frequency.value = frequency

  // Ramped rather than switched on/off — an abrupt gain change clicks, which
  // is exactly the harshness this sound must avoid. A touch slower than a
  // hard on/off, so the attack itself reads as "chime" rather than "click".
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(0.055, startAt + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)

  osc.connect(gain)
  gain.connect(context.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.02)
}

/**
 * Plays the notification blip. Safe to call at any time: browsers only allow
 * audio after the user has interacted with the page, so before that first
 * click/keypress the context stays suspended and this simply does nothing.
 * That's the documented policy, not a failure — no attempt is made to work
 * around it.
 */
export function playNotificationSound(): void {
  const context = getContext()
  if (!context) return

  const start = () => {
    const now = context.currentTime
    // E5 -> A5, a perfect fourth up — a clearly ascending "message" pip
    // rather than the shutter-like interval before. The second tone starts
    // while the first is still decaying (legato), so the pair reads as one
    // soft two-note chime instead of two separate clicks.
    tone(context, 659.25, now, 0.13)
    tone(context, 880, now + 0.09, 0.16)
  }

  if (context.state === 'suspended') {
    context.resume().then(start, () => {
      // Still no user gesture on this page — stay silent.
    })
    return
  }

  start()
}
