import { useEffect } from 'react'

// Branded 404 for the app site. The SPA catch-all rewrite in netlify.toml
// means Netlify's own 404 page can never surface here, so this is the only
// place a wrong URL on app.retain-growth.ai can land. The landing site has a
// static twin at landing/404.html — keep the two in sync if the wording
// changes.
export default function NotFound({
  title = 'Такої сторінки немає',
  text = 'Схоже, в посиланні загубився символ. Перевірте адресу або поверніться на головну.',
  href = '/login',
  cta = 'На головну',
}: {
  title?: string
  text?: string
  href?: string
  cta?: string
}) {
  useEffect(() => {
    document.documentElement.classList.add('lp-html')
    const prev = document.title
    document.title = title
    return () => {
      document.documentElement.classList.remove('lp-html')
      document.title = prev
    }
  }, [title])

  return (
    <div className="nf">
      <div className="nf-glow" aria-hidden="true" />
      <div className="nf-inner">
        <span className="nf-code">404</span>
        <h1>{title}</h1>
        <p>{text}</p>
        <a className="nf-btn" href={href}>
          {cta}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </a>
      </div>
    </div>
  )
}
