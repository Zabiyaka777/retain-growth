import { Navigate, Route, Routes } from 'react-router-dom'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Chats from './pages/Chats'
import Crm from './pages/Crm'
import Settings from './pages/Settings'
import Profile from './pages/Profile'
import Funnels from './pages/Funnels'
import FunnelBuilder from './pages/FunnelBuilder'
import AdminLayout from './components/AdminLayout'
import AdminOrganizations from './pages/AdminOrganizations'
import AdminOrganization from './pages/AdminOrganization'
import AdminSecurity from './pages/AdminSecurity'
import Elements from './pages/Elements'
import LeadGenTools from './pages/LeadGenTools'
import LeadGenLinkForm from './pages/LeadGenLinkForm'
import Analytics from './pages/Analytics'
import LandingPage from './pages/LandingPage'
import LandingPageForm from './pages/LandingPageForm'
import NotFound from './pages/NotFound'
import DashboardLayout from './components/DashboardLayout'
import AdminSettings from './pages/AdminSettings'

// netlify/edge-functions/custom-domain.ts resolves a tenant's own custom
// domain to its landing page's slug and injects it here before the SPA even
// loads — window.__LP_SLUG__ is only ever set by that edge function (never
// by our own code), so its presence is exactly "this request came in on a
// registered custom domain". LandingPage itself already falls back to it
// when there's no :slug route param (see that file) — this is just what
// decides whether "/" renders the landing or the normal login redirect.
const customDomainSlug = typeof window !== 'undefined' ? (window as { __LP_SLUG__?: string }).__LP_SLUG__ : undefined

function App() {
  return (
    <Routes>
      <Route path="/" element={customDomainSlug ? <LandingPage /> : <Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      {/* Public — no auth guard: the guard lives in DashboardLayout, this is outside it. */}
      <Route path="/lp/:slug" element={<LandingPage />} />
      <Route path="/dashboard" element={<DashboardLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="chats" element={<Chats />} />
        <Route path="crm" element={<Crm />} />
        <Route path="funnels" element={<Funnels />} />
        <Route path="funnel-builder/:funnelId" element={<FunnelBuilder />} />
        <Route path="elements" element={<Elements />} />
        <Route path="leadgentools" element={<LeadGenTools />} />
        <Route path="leadgentools/new" element={<LeadGenLinkForm />} />
        <Route path="leadgentools/landings/new" element={<LandingPageForm />} />
        <Route path="leadgentools/landings/:pageId" element={<LandingPageForm />} />
        <Route path="leadgentools/:linkId" element={<LeadGenLinkForm />} />
        <Route path="templates" element={<Navigate to="/dashboard/elements?tab=templates" replace />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="ai" element={<Navigate to="/dashboard/settings?tab=ai" replace />} />
        <Route path="settings" element={<Settings />} />
        <Route path="profile" element={<Profile />} />
        <Route path="integrations" element={<Navigate to="/dashboard/settings" replace />} />
      </Route>
      {/* Platform operator surface — its own layout and its own guard, kept
          off /dashboard so it can never be mistaken for a tenant page. */}
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to="/admin/organizations" replace />} />
        <Route path="organizations" element={<AdminOrganizations />} />
        <Route path="organizations/:orgId" element={<AdminOrganization />} />
        <Route path="security" element={<AdminSecurity />} />
        <Route path="settings" element={<AdminSettings />} />
      </Route>

      {/* Branded 404: the SPA catch-all rewrite means Netlify's own 404
          page can never surface on this site, so this route is it. */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

export default App
