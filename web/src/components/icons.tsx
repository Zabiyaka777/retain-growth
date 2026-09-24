import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(props: IconProps) {
  const { size = 18, ...rest } = props
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  }
}

export function IconGrid(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

export function IconChat(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21 12a8 8 0 0 1-8 8H6.5a1 1 0 0 1-.8-1.6L7 16.5A8 8 0 1 1 21 12Z" />
      <path d="M8 10.5h8M8 13.5h5" />
    </svg>
  )
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9.5a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.14.42.42.79.79 1.04.36.24.79.37 1.22.37H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.59Z" />
    </svg>
  )
}

export function IconUser(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.4-3.4 4.3-5.2 7.5-5.2s6.1 1.8 7.5 5.2" />
    </svg>
  )
}

export function IconLogout(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

export function IconPlug(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
      <path d="M12 17v4" />
    </svg>
  )
}

export function IconBuilding(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1" />
    </svg>
  )
}

export function IconMail(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6 8.5 7 8.5-7" />
    </svg>
  )
}

// Bell-with-slash — the standard "muted notifications / unsubscribed" glyph,
// unambiguous next to a plain bell (subscribed) the way IconMail never was.
export function IconBellOff(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" />
      <path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      <path d="M2 2l20 20" />
    </svg>
  )
}

export function IconBell(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

export function IconPaperclip(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

export function IconLock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  )
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

export function IconArrowLeft(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}

export function IconLogIn(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 21h3a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  )
}

export function IconBolt(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z" />
    </svg>
  )
}

export function IconTag(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12.5 3H6a2 2 0 0 0-2 2v6.5a2 2 0 0 0 .586 1.414l8 8a2 2 0 0 0 2.828 0l6-6a2 2 0 0 0 0-2.828l-8-8A2 2 0 0 0 12.5 3Z" />
      <circle cx="8" cy="8" r="1.25" />
    </svg>
  )
}

export function IconBraces(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 4.5c-1.4 0-2 .7-2 2V9c0 1-.9 1.5-1.5 1.5.6 0 1.5.5 1.5 1.5v2.5c0 1.3.6 2 2 2" />
      <path d="M16 4.5c1.4 0 2 .7 2 2V9c0 1 .9 1.5 1.5 1.5-.6 0-1.5.5-1.5 1.5v2.5c0 1.3-.6 2-2 2" />
    </svg>
  )
}

export function IconImage(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 15.5 16 10 5 20" />
    </svg>
  )
}

export function IconVideo(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M15 10.5 21 7v10l-6-3.5Z" />
    </svg>
  )
}

export function IconVideoNote(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 9l5 3-5 3V9Z" />
    </svg>
  )
}

export function IconMusic(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  )
}

export function IconFile(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

export function IconMic(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3M9 21h6" />
    </svg>
  )
}

export function IconPoll(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 20v-6M12 20V6M20 20v-9" />
    </svg>
  )
}

export function IconClose(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

export function IconGrip(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="6" r="1.25" />
      <circle cx="15" cy="6" r="1.25" />
      <circle cx="9" cy="12" r="1.25" />
      <circle cx="15" cy="12" r="1.25" />
      <circle cx="9" cy="18" r="1.25" />
      <circle cx="15" cy="18" r="1.25" />
    </svg>
  )
}

export function IconSync(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12a8 8 0 0 1 14-5.3L21 9" />
      <path d="M21 4v5h-5" />
      <path d="M20 12a8 8 0 0 1-14 5.3L3 15" />
      <path d="M3 20v-5h5" />
    </svg>
  )
}

export function IconSpinner(props: IconProps) {
  return (
    <svg {...base(props)} className={`icon-spin ${props.className ?? ''}`}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

export function IconInbox(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12h4l1.5 3h5L16 12h4" />
      <path d="M5.5 5h13L21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6l2.5-7Z" />
    </svg>
  )
}

export function IconTrendingUp(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  )
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3" />
      <path d="M2.5 19c1.2-3 3.6-4.5 6.5-4.5s5.3 1.5 6.5 4.5" />
      <circle cx="17" cy="8" r="2.5" />
      <path d="M16 11.2c2 .4 3.5 1.8 4.5 4.3" />
    </svg>
  )
}

export function IconCheckCircle(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  )
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17.2v.1" />
    </svg>
  )
}

export function IconFunnel(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4h16l-6 8v6l-4 2v-8L4 4Z" />
    </svg>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

export function IconChevronUp(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 15l6-6 6 6" />
    </svg>
  )
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function IconLink(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.5 13.5 4a3.5 3.5 0 0 1 5 5L16 11.5" />
      <path d="M13 17.5 10.5 20a3.5 3.5 0 0 1-5-5L8 12.5" />
    </svg>
  )
}

export function IconSend(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m3.5 12 17-8.5-6 17-3.5-7-7.5-1.5Z" />
      <path d="M14.5 3.5 8 12" />
    </svg>
  )
}

export function IconPhone(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5.5 4h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 4 6.6 1.5 1.5 0 0 1 5.5 4Z" />
    </svg>
  )
}

export function IconBubble(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="11" r="8" />
      <path d="M8 21l1.5-4" />
    </svg>
  )
}

export function IconStopwatch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 10v3.5l2.2 2.2" />
      <path d="M9.5 2h5" />
      <path d="M18.5 7 20 5.5" />
    </svg>
  )
}

export function IconBranch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5h3.5a4 4 0 0 1 3.2 1.6l4.6 6.1A4 4 0 0 0 18.5 15H21" />
      <path d="M4 19h3.5a4 4 0 0 0 3.2-1.6l1.3-1.7" />
      <path d="M18 12l3 3-3 3" />
      <path d="M18 2l3 3-3 3" />
      <path d="M15.5 5H18.5" />
    </svg>
  )
}

export function IconShield(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3l7 3v5.5c0 4.2-2.9 7.7-7 8.5-4.1-.8-7-4.3-7-8.5V6l7-3Z" />
    </svg>
  )
}

export function IconCpu(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </svg>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

export function IconListChecks(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 6.5 4.5 8 7.5 5" />
      <path d="M3 12.5 4.5 14 7.5 11" />
      <path d="M3 18.5 4.5 20 7.5 17" />
      <path d="M11 6.5h10M11 12.5h10M11 18.5h7" />
    </svg>
  )
}

export function IconSparkles(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5 13.7 8.3 18.5 10 13.7 11.7 12 16.5 10.3 11.7 5.5 10 10.3 8.3 12 3.5Z" />
      <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8L18 16Z" />
    </svg>
  )
}

export function IconEdit(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4.5 1.5L5 16 16.5 4.5Z" />
      <path d="M14.5 6.5 17.5 9.5" />
    </svg>
  )
}

export function IconBan(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.4 6.4l11.2 11.2" />
    </svg>
  )
}

export function IconArchiveBox(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="4" width="17" height="4.5" rx="1" />
      <path d="M5 8.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V8.5" />
      <path d="M10 12.5h4" />
    </svg>
  )
}

export function IconCode(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 8 4.5 12 9 16" />
      <path d="M15 8l4.5 4-4.5 4" />
    </svg>
  )
}

export function IconMeta(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6.5 16.5C4 16.5 2.5 14.2 2.5 12S4 7.5 6.5 7.5c2.1 0 3.6 1.7 5.5 4.5" />
      <path d="M17.5 16.5c2.5 0 4-2.3 4-4.5s-1.5-4.5-4-4.5c-2.1 0-3.6 1.7-5.5 4.5" />
      <path d="M6.5 7.5c2.1 0 3.6 1.7 5.5 4.5 1.9 2.8 3.4 4.5 5.5 4.5" />
    </svg>
  )
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.8-4.8" />
    </svg>
  )
}

export function IconDuplicate(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2.5" />
    </svg>
  )
}

export function IconChecklist(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="6" height="6" rx="1.25" />
      <path d="M4.5 7l1 1 2-2" />
      <path d="M12 6.5h9" />
      <rect x="3" y="14" width="6" height="6" rx="1.25" />
      <path d="M12 17h9" />
    </svg>
  )
}

export function IconNote(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  )
}

export function IconUpload(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

export function IconTarget(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  )
}

export function IconHistory(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 9A9 9 0 1 1 3 12" />
      <path d="M3 4.5V9h4.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  )
}

export function IconCreditCard(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 9.5h19" />
      <path d="M6 15h4" />
    </svg>
  )
}
