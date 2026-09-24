const MARQUEE_WORDS = ['RETAIN GROWTH', 'ЛІДИ', 'ТРЕДИ', 'ТУНЕЛІ ПРОДАЖ', 'АВТОМАТИЗАЦІЯ']

export default function Marquee() {
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {[0, 1].map((rep) => (
          <span className="marquee-row" key={rep}>
            {MARQUEE_WORDS.map((word, i) => (
              <span className="marquee-item" key={`${rep}-${i}`}>
                {word}
                <span className="marquee-dot" />
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  )
}
