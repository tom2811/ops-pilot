import { Navigate, NavLink, Outlet, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./auth.js";
import { AccountPage } from "./pages/AccountPage.js";
import { AdminPage } from "./pages/AdminPage.js";
import { AuditLogPage } from "./pages/AuditLogPage.js";
import { InvitationPage } from "./pages/InvitationPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { FeedbackPage } from "./pages/FeedbackPage.js";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordPages.js";
import { PlatformPage } from "./pages/PlatformPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import { TicketDetailPage } from "./pages/TicketDetailPage.js";
import { TicketsPage } from "./pages/TicketsPage.js";
import { UsersPage } from "./pages/UsersPage.js";

function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {label}
    </div>
  );
}

function HomeRedirect() {
  const { user, memberships, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (memberships.length === 0 && user.isPlatformAdmin) return <Navigate to="/platform" replace />;
  if (memberships.length === 0) return <NoMembership />;
  return <Navigate to={`/t/${memberships[0]?.slug}/tickets`} replace />;
}

function NoMembership() {
  const { user, logout } = useAuth();
  return (
    <div className="center-page">
      <div className="card narrow">
        <div className="brand-mark">OP</div>
        <h1>No workspace yet</h1>
        <p className="muted">
          Signed in as {user?.email}. This account has no active tenant membership.
        </p>
        {user?.isPlatformAdmin && (
          <button className="button secondary" onClick={() => window.location.assign("/platform")}>
            Platform
          </button>
        )}
        <button className="button secondary" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function TenantLayout() {
  const { tenantSlug = "" } = useParams();
  const { user, memberships, loading, logout } = useAuth();
  const navigate = useNavigate();

  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  const membership = memberships.find((item) => item.slug === tenantSlug);
  if (!membership) {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1>Workspace not available</h1>
          <p className="muted">You are not a member of this workspace.</p>
          <button className="button" onClick={() => navigate("/")}>
            Go to my workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("/")} title="OpsPilot">
          <span className="brand-mark small">OP</span>
          <span>OpsPilot</span>
        </button>
        <nav className="main-nav">
          <NavLink to={`/t/${tenantSlug}/tickets`}>Tickets</NavLink>
          {membership.permissions.includes("config.manage") && (
            <NavLink to={`/t/${tenantSlug}/admin`}>Admin</NavLink>
          )}
          {membership.permissions.includes("reports.view") && (
            <NavLink to={`/t/${tenantSlug}/reports`}>Reports</NavLink>
          )}
          {membership.permissions.includes("users.manage") && (
            <NavLink to={`/t/${tenantSlug}/users`}>People</NavLink>
          )}
          {membership.permissions.includes("audit.view") && (
            <NavLink to={`/t/${tenantSlug}/audit`}>Audit</NavLink>
          )}
        </nav>
        <div className="topbar-right">
          <select
            aria-label="Workspace"
            value={tenantSlug}
            onChange={(event) => navigate(`/t/${event.target.value}/tickets`)}
          >
            {memberships.map((item) => (
              <option key={item.id} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
          {user.isPlatformAdmin && <NavLink className="account-link" to="/platform">Platform</NavLink>}
          <NavLink className="account-link" to="/account">Account</NavLink>
          <div className="user-chip" title={user.email}>
            <span>{user.displayName}</span>
            <span className="role-dot">{membership.role.replace("_", " ")}</span>
          </div>
          <button
            className="button ghost small"
            onClick={() => {
              void logout().then(() => navigate("/login"));
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="center-page">
      <div className="card narrow">
        <h1>Not found</h1>
        <p className="muted">That page does not exist.</p>
        <a className="button" href="/">
          Back home
        </a>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/invite/:token" element={<InvitationPage />} />
      <Route path="/feedback" element={<FeedbackPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/platform" element={<PlatformPage />} />
      <Route path="/t/:tenantSlug" element={<TenantLayout />}>
        <Route index element={<Navigate to="tickets" replace />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="tickets/:ticketId" element={<TicketDetailPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="audit" element={<AuditLogPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
