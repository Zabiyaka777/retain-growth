import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { useChatNotifications } from '../hooks/useChatNotifications'
import {
  IconChat,
  IconFunnel,
  IconGrid,
  IconLink,
  IconLogout,
  IconSettings,
  IconSpinner,
  IconTag,
  IconTrendingUp,
  IconUser,
  IconUsers,
  IconChevronRight,
  IconShield,
} from './icons'

const SIDEBAR_KEY = 'rg-sidebar-collapsed'

// Collapsed by default: the icon rail gives every page more horizontal room,
// which is what the chat workspace needs most. Reading the stored choice in
// the initialiser avoids a first paint in the wrong state.
function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_KEY)
    return stored === null ? true : stored === '1'
  } catch {
    return true
  }
}

// aiBadge: pins a small "AI" tag onto the item's icon. Only Тунелі продаж
// carries it — AI nodes live inside the funnel builder, and the badge is what
// signposts that now that the standalone AI page is gone. It sits on the icon
// (not the label) because the label is hidden in the narrow top-bar layout.
const navItems = [
  { to: '/dashboard', label: 'Дашборд', icon: IconGrid, end: true, aiBadge: false },
  { to: '/dashboard/chats', label: 'Чати', icon: IconChat, end: false, aiBadge: false, unreadBadge: true },
  { to: '/dashboard/crm', label: 'CRM', icon: IconUsers, end: false, aiBadge: false },
  { to: '/dashboard/funnels', label: 'Тунелі продаж', icon: IconFunnel, end: false, aiBadge: true },
  { to: '/dashboard/leadgentools', label: 'Лідогенерація', icon: IconLink, end: false, aiBadge: false },
  { to: '/dashboard/analytics', label: 'Аналітика', icon: IconTrendingUp, end: false, aiBadge: false },
  { to: '/dashboard/elements', label: 'Елементи', icon: IconTag, end: false, aiBadge: false },
  { to: '/dashboard/settings', label: 'Налаштування', icon: IconSettings, end: false, aiBadge: false },
  { to: '/dashboard/profile', label: 'Профіль', icon: IconUser, end: false, aiBadge: false },
]

export default function DashboardLayout() {
  const { session, loading } = useAuth()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const unreadThreads = useChatNotifications()
  // Same query AdminLayout's guard uses: RLS lets a user read only their own
  // platform_admins row, so an empty result is a definitive "not an admin".
  // Starts false so the item never flashes for an ordinary user mid-check.
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    if (!session) return

    supabase
      .from('platform_admins')
      .select('user_id')
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data)))
  }, [session])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
    } catch {
      // Private mode or blocked storage — the choice just won't persist.
    }
  }, [collapsed])

  if (loading) {
    return (
      <div className="center-screen">
        <IconSpinner size={22} />
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  const email = session.user.email ?? ''
  const initial = email.charAt(0) || '?'

  return (
    <div className={`app-shell${collapsed ? ' sidebar-is-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark">RG</span>
          <span>Retain Growth</span>
        </div>

        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Розгорнути меню' : 'Згорнути меню'}
          title={collapsed ? 'Розгорнути меню' : 'Згорнути меню'}
        >
          <IconChevronRight size={14} aria-hidden="true" />
        </button>

        <nav className="sidebar-nav">
          {navItems.map(({ to, label, icon: Icon, end, aiBadge, unreadBadge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              // Feeds the CSS tooltip shown while collapsed, and keeps the
              // item reachable by name for assistive tech when the visible
              // label is hidden.
              data-label={label}
              aria-label={label}
            >
              <span className="sidebar-icon-wrap">
                <Icon size={18} />
                {aiBadge && (
                  <span className="sidebar-ai-badge" aria-hidden="true">
                    AI
                  </span>
                )}
                {/* On the icon, not the label: the label is hidden while the
                    rail is collapsed, which is its default state. */}
                {unreadBadge && unreadThreads > 0 && (
                  <span className="sidebar-unread-badge" aria-label={`${unreadThreads} непрочитаних тредів`}>
                    {unreadThreads > 99 ? '99+' : unreadThreads}
                  </span>
                )}
              </span>
              <span className="sidebar-link-label">{label}</span>
            </NavLink>
          ))}

          {/* Rendered only for platform admins — absent from the DOM entirely
              for everyone else, not merely hidden. This is convenience, not a
              control: /admin has its own guard and every admin endpoint
              re-checks membership server-side. */}
          {isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) => `sidebar-link sidebar-link-admin${isActive ? ' active' : ''}`}
              data-label="Адмінка"
              aria-label="Адмінка"
            >
              <span className="sidebar-icon-wrap">
                <IconShield size={18} />
              </span>
              <span className="sidebar-link-label">Адмінка</span>
            </NavLink>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <span className="sidebar-avatar">{initial}</span>
            <span className="sidebar-user-email">{email}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => supabase.auth.signOut()}>
            <IconLogout size={16} />
            <span>Вийти</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
