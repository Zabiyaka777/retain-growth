import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface HoverTooltipProps {
  content: ReactNode
  children: ReactNode
}

const TOOLTIP_MAX_WIDTH = 260

interface Coords {
  left: number
  top?: number
  bottom?: number
}

// Portalled to <body> and positioned from getBoundingClientRect rather than
// a plain CSS :hover + position:absolute — both the thread list and the CRM
// table wrap their rows in an overflow:auto/scroll container, which would
// clip an absolutely-positioned tooltip the moment it extended past the row.
export default function HoverTooltip({ content, children }: HoverTooltipProps) {
  const [coords, setCoords] = useState<Coords | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - TOOLTIP_MAX_WIDTH - 12))
    // Flips above the trigger when there isn't much room below — a rough
    // heuristic (most tooltip content is short), not a measured fit.
    const flipUp = rect.bottom > window.innerHeight - 160
    setCoords(flipUp ? { left, bottom: window.innerHeight - rect.top + 8 } : { left, top: rect.bottom + 8 })
  }

  function hide() {
    setCoords(null)
  }

  return (
    <span
      ref={triggerRef}
      className="hover-tooltip-trigger"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={0}
    >
      {children}
      {coords &&
        createPortal(
          <div
            className="hover-tooltip"
            role="tooltip"
            style={{ left: coords.left, top: coords.top, bottom: coords.bottom, maxWidth: TOOLTIP_MAX_WIDTH }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  )
}
