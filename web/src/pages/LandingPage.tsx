import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { LandingTemplate, withConfigDefaults, type CtaChannel, type LandingConfig, type LandingCta, type LandingTemplateKey } from '../components/LandingTemplates'
import NotFound from './NotFound'

const THEME_BG: Record<string, string> = { white: '#ffffff', dark: '#141316', rg: '#050608' }

function readCookie(name: string) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1] ?? ''
}

// Meta's own click cookie. The browser pixel writes it too, but only once its
// script has loaded (and never if it is blocked), so it is set here the moment
// the page opens with an fbclid — that way the Lead a few seconds later still
// carries the original click. Same format and 90-day life as Meta's.
function ensureFbc(fbclid: string) {
  if (!fbclid || readCookie('_fbc')) return
  document.cookie = `_fbc=fb.1.${Date.now()}.${encodeURIComponent(fbclid)}; path=/; max-age=${90 * 86400}; SameSite=Lax`
}

function newEventId(kind: string, slug: string) {
  return `lp-${kind}-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Operator-supplied <head>/<body> code is NEVER injected into this document.
// /lp lives on the same origin as the dashboard, so a script running here
// could read the Supabase session out of localStorage — one org's marketer
// could then lift the session of any logged-in user who opens their public
// page. It is rendered inside a sandboxed iframe instead (see CustomCode):
// `allow-scripts` without `allow-same-origin` gives the frame an opaque
// origin, so it can run analytics and call out to the network but cannot
// reach this page's storage, cookies or DOM.
function CustomCode({ head, body }: { head: string; body: string }) {
  if (!head.trim() && !body.trim()) return null
  const doc = `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`
  return <iframe className="lp-custom-code" title="Custom code" sandbox="allow-scripts" srcDoc={doc} tabIndex={-1} aria-hidden="true" />
}

function injectScript(code: string, sink: Node[]) {
  const s = document.createElement('script')
  s.text = code
  document.head.appendChild(s)
  sink.push(s)
}

function injectSrc(src: string, sink: Node[]) {
  const s = document.createElement('script')
  s.async = true
  s.src = src
  document.head.appendChild(s)
  sink.push(s)
}

function setMeta(name: string, content: string, sink: Node[]) {
  if (!content) return
  const m = document.createElement('meta')
  m.setAttribute('name', name)
  m.setAttribute('content', content)
  document.head.appendChild(m)
  sink.push(m)
}

// Public landing page: /lp/:slug (any ad params — fbclid, utm_* — ride along).
// Sits outside DashboardLayout on purpose, so its auth guard never applies.
// A landing is self-contained: its messenger buttons go to landing-go.ts,
// which logs the click and sends the visitor into the org's bot — the page
// carries its own funnel + entry point and never touches lead-gen links.
export default function LandingPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [params] = useSearchParams()
  const [state, setState] = useState<{ templateKey: LandingTemplateKey; config: LandingConfig; capi: boolean; routable: boolean } | null | 'error'>(null)
  const injected = useRef<Node[]>([])

  useEffect(() => {
    document.documentElement.classList.add('lp-html')
    return () => {
      document.documentElement.classList.remove('lp-html')
      document.documentElement.style.background = ''
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(`/.netlify/functions/landing-page-config?${new URLSearchParams({ slug }).toString()}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (cancelled) return
        setState({ templateKey: data.templateKey, config: withConfigDefaults(data.config), capi: !!data.capi, routable: !!data.routable })
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  // Everything the operator configured under "Технічні": SEO tags, analytics
  // snippets and their own head/body code. Runs once per loaded page and is
  // torn down on unmount.
  useEffect(() => {
    if (!state || state === 'error') return
    const c = state.config
    const sink: Node[] = []
    injected.current = sink

    document.title = c.seo_title || c.headline || 'Retain Growth'
    setMeta('description', c.seo_description, sink)
    document.documentElement.style.background = THEME_BG[c.theme] ?? THEME_BG.rg

    // Shared between the browser pixel and the server-side CAPI call so Meta
    // deduplicates the two reports of this one page view.
    const eventId = newEventId('view', slug)
    ensureFbc(params.get('fbclid') ?? '')

    if (c.fb_pixel_id) {
      injectScript(
        `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');` +
          `fbq('init',${JSON.stringify(c.fb_pixel_id)});fbq('track','PageView',{},{eventID:${JSON.stringify(eventId)}});`,
        sink,
      )
    }
    if (c.tiktok_pixel_id) {
      injectScript(
        `!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=r;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript";o.async=!0;o.src=r+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load(${JSON.stringify(c.tiktok_pixel_id)});ttq.page()}(window,document,'ttq');`,
        sink,
      )
    }
    if (c.google_tag_id) {
      injectSrc(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(c.google_tag_id)}`, sink)
      injectScript(
        `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',${JSON.stringify(c.google_tag_id)});`,
        sink,
      )
    }

    if (state.capi) reportCapi('PageView', eventId)

    return () => {
      sink.forEach((n) => {
        if (n.parentNode) n.parentNode.removeChild(n)
      })
      injected.current = []
    }
    // params/slug are stable for the lifetime of one loaded page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Server-side mirror of a browser pixel event (see landing-page-view.ts).
  // keepalive so navigating straight into the messenger doesn't cancel it.
  function reportCapi(eventName: 'PageView' | 'Lead', eventId: string) {
    fetch('/.netlify/functions/landing-page-view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        slug,
        eventName,
        eventId,
        fbclid: params.get('fbclid') ?? undefined,
        fbp: readCookie('_fbp') || undefined,
        fbc: decodeURIComponent(readCookie('_fbc')) || undefined,
        url: window.location.href,
      }),
    }).catch(() => {
      /* reporting must never break the page */
    })
  }

  // The landing page's own conversion: a click on any of its CTAs is a Lead
  // on the page's own pixel.
  // Browser and server share the event id so Meta counts it once.
  function onCta(cta: LandingCta) {
    if (!state || state === 'error' || !state.config.fb_pixel_id) return
    const eventId = newEventId('lead', slug)
    const fbq = (window as unknown as { fbq?: (...a: unknown[]) => void }).fbq
    fbq?.('track', 'Lead', { content_name: cta.channel }, { eventID: eventId })
    if (state.capi) reportCapi('Lead', eventId)
  }

  // The button goes to landing-go with the ad params this page was opened
  // with (fbclid, utm_*), which it stores as the click's captured params. A
  // page with no tunnel set (yet) gets a dead '#' rather than a broken hop.
  const ctaHref = (channel: CtaChannel) => {
    if (!state || state === 'error' || !state.routable) return '#'
    const q = new URLSearchParams()
    params.forEach((value, key) => {
      if (key !== 'slug' && key !== 'ch') q.set(key, value)
    })
    q.set('slug', slug)
    q.set('ch', channel)
    return `/.netlify/functions/landing-go?${q.toString()}`
  }

  if (state === null) return <div className="lp-state" aria-busy="true" />
  // 404 only when the page itself could not be loaded.
  if (state === 'error') {
    return (
      <NotFound
        title="Сторінку не знайдено"
        text="Можливо, її зняли з публікації або в посиланні загубився символ."
        href="https://retain-growth.ai"
        cta="На retain-growth.ai"
      />
    )
  }
  return (
    <>
      <LandingTemplate templateKey={state.templateKey} config={state.config} ctaHref={ctaHref} onCta={onCta} />
      <CustomCode head={state.config.head_code} body={state.config.body_code} />
    </>
  )
}
