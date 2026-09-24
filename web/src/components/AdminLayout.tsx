import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet, Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { IconArrowLeft, IconBuilding, IconShield, IconSpinner } from './icons'

const adminNav = [
  { to: '/admin/organizations', label: 'Організації', icon: IconBuilding },
  { to: '/admin/security', label: 'Безпека', icon: IconShield },
]

/**
 * Separate shell from DashboardLayout: this is platform-operator surface, not
 * another tab of a tenant's workspace, and it should never look like one.
 *
 * The membership check here is for UX only — it decides what to render, not
 * what the caller may read. Every admin endpoint re-checks platform_admins
 * server-side, because anything this component believes is trivially forged.
 */
export default function AdminLayout() {
  const { session, loading } = useAuth()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    if (!session) return

    // RLS lets a user read only their own platform_admins row, so an empty
    // result is a definitive "not an admin".
    supabase
      .from('platform_admins')
      .select('user_id')
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data)))
  }, [session])

  if (loading) return null
  if (!session) return <Navigate to="/login" replace />

  if (isAdmin === null) {
    return (
      <div className="admin-gate">
        <IconSpinner size={20} />
      </div>
    )
  }

  // Back to their own workspace rather than an error page: a non-admin
  // reaching /admin is almost always a stale bookmark, not an attack.
  if (!isAdmin) return <Navigate to="/dashboard" replace />

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-brand">
          <IconShield size={17} aria-hidden="true" />
          <span>Адміністрування платформи</span>
        </div>

        <nav className="admin-nav">
          {adminNav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `admin-nav-link${isActive ? ' active' : ''}`}>
              <Icon size={15} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>

        <Link to="/dashboard" className="btn btn-ghost admin-exit">
          <IconArrowLeft size={15} />
          До кабінету
        </Link>
      </header>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  )
}
