import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { humanize } from "./api.js";
import { hasSessionHint, useAuth } from "./auth.js";
import type { User } from "./types.js";
import { ErrorBoundary, PageSkeleton } from "./components.js";
import { Icon, BrandMark, Menu, ThemeToggle, useTheme, type IconName } from "./ui.js";
import { AccountPage } from "./pages/AccountPage.js";
import { AdminPage } from "./pages/AdminPage.js";
import { AuditLogPage } from "./pages/AuditLogPage.js";
import { EmailLogsPage } from "./pages/EmailLogsPage.js";
import { InvitationPage } from "./pages/InvitationPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { FeedbackPage } from "./pages/FeedbackPage.js";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordPages.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PlatformPage } from "./pages/PlatformPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import { TicketDetailPage } from "./pages/TicketDetailPage.js";
import { TicketsPage } from "./pages/TicketsPage.js";
import { UsersPage } from "./pages/UsersPage.js";

function TenantLayoutSkeleton({
  collapsed,
  setCollapsed,
}: {
  collapsed: boolean;
  setCollapsed: (val: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const { theme, toggleTheme } = useTheme();
  return (
    <div className={`app-shell ${collapsed ? "is-collapsed" : ""}`.trim()}>
      <aside className="sidebar" id="app-sidebar" aria-label="Main navigation">
        <div className="sb-brand">
          <BrandMark />
          <span className="sb-brand-text">
            <strong>OpsPilot</strong>
            <span>Service desk</span>
          </span>
        </div>

        <div className="ws-switch">
          <div className="ws-trigger" style={{ pointerEvents: "none" }}>
            <span className="ws-mark skeleton" style={{ width: 28, height: 28, borderRadius: 4 }} />
            <span className="ws-meta">
              <span className="skeleton" style={{ width: 88, height: 12, marginBottom: 4 }} />
              <span className="skeleton" style={{ width: 48, height: 9 }} />
            </span>
          </div>
        </div>

        <nav className="sb-nav" aria-hidden="true">
          <div>
            <p className="sb-label">Workspace</p>
            <div className="sb-item" style={{ opacity: 0.6 }}><Icon name="overview" /><span className="sb-item-label">Overview</span></div>
            <div className="sb-item" style={{ opacity: 0.6 }}><Icon name="ticket" /><span className="sb-item-label">Tickets</span></div>
          </div>
          <div>
            <p className="sb-label">Insights</p>
            <div className="sb-item" style={{ opacity: 0.6 }}><Icon name="reports" /><span className="sb-item-label">Reports</span></div>
            <div className="sb-item" style={{ opacity: 0.6 }}><Icon name="audit" /><span className="sb-item-label">Audit log</span></div>
            <div className="sb-item" style={{ opacity: 0.6 }}><Icon name="email" /><span className="sb-item-label">Email logs</span></div>
          </div>
          <div>
            <p className="sb-label">Configure</p>
            <div className="sb-item" style={{ opacity: 0.6 }}><Icon name="admin" /><span className="sb-item-label">Configuration</span></div>
            <div className="sb-item" style={{ opacity: 0.6 }}><Icon name="people" /><span className="sb-item-label">People</span></div>
          </div>
        </nav>

        <div className="sb-foot">
          <div className="sb-account" style={{ pointerEvents: "none" }}>
            <span className="avatar skeleton" style={{ width: 28, height: 28, borderRadius: "50%" }} />
            <span className="account-meta">
              <span className="skeleton" style={{ width: 72, height: 11, marginBottom: 4 }} />
              <span className="skeleton" style={{ width: 44, height: 8 }} />
            </span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn sb-collapse"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((current) => !current)}
          >
            <Icon name="sidebar" />
          </button>
          <div className="crumb">
            <span className="skeleton" style={{ width: 70, height: 14 }} />
            <span className="sep workspace-sep">/</span>
            <span className="skeleton" style={{ width: 90, height: 14 }} />
          </div>
          <div className="topbar-right">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </header>
        <main className="page">
          <PageSkeleton rows={5} cols={5} label="Loading workspace" />
        </main>
      </div>
    </div>
  );
}

function HomeRedirect() {
  const { user, memberships, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (memberships.length === 0 && user.isPlatformAdmin) return <Navigate to="/platform" replace />;
  if (memberships.length === 0) return <NoMembership />;
  return <Navigate to={`/t/${memberships[0]?.slug}/overview`} replace />;
}

function NoMembership() {
  const { user, logout } = useAuth();
  return (
    <div className="center-page">
      <div className="card narrow">
        <BrandMark />
        <h1>No workspace yet</h1>
        <p className="muted">
          Signed in as {user?.email}. This account has no active tenant membership.
        </p>
        {user?.isPlatformAdmin && (
          <Link className="button secondary" to="/platform">
            Platform
          </Link>
        )}
        <button className="button secondary" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function AccountMenuItems({
  user,
  close,
  signOut,
}: {
  user: User;
  close: () => void;
  signOut: () => void;
}) {
  return (
    <>
      <div className="menu-head">
        <strong>{user.displayName}</strong>
        <span>{user.email}</span>
      </div>
      <Link className="menu-item" role="menuitem" to="/account" onClick={close}>
        <Icon name="account" />
        Account settings
      </Link>
      {user.isPlatformAdmin && (
        <Link className="menu-item" role="menuitem" to="/platform" onClick={close}>
          <Icon name="platform" />
          Platform
        </Link>
      )}
      <div className="menu-sep" />
      <button
        type="button"
        className="menu-item"
        role="menuitem"
        onClick={() => {
          close();
          signOut();
        }}
      >
        <Icon name="logout" />
        Sign out
      </button>
    </>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function sectionTitle(pathname: string): string {
  if (pathname.includes("/overview")) return "Overview";
  if (pathname.includes("/admin")) return "Configuration";
  if (pathname.includes("/reports")) return "Reports";
  if (pathname.includes("/users")) return "People";
  if (pathname.includes("/email-logs")) return "Email delivery logs";
  if (pathname.includes("/audit")) return "Audit log";
  if (/\/tickets\/[^/]+/.test(pathname)) return "Ticket";
  return "Tickets";
}

const SIDEBAR_KEY = "opspilot.sidebar";

function readSidebarCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    if (stored === "collapsed") return true;
    if (stored === "expanded") return false;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia("(max-width: 1099px)").matches;
}

function TenantLayout() {
  const { tenantSlug = "" } = useParams();
  const { user, memberships, loading, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const sidebar = document.getElementById("app-sidebar");
    const firstLink = sidebar?.querySelector<HTMLElement>(".sb-item");
    firstLink?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        sidebar?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      menuBtnRef.current?.focus();
    };
  }, [drawerOpen]);

  if (loading) {
    if (!hasSessionHint()) return null;
    return <TenantLayoutSkeleton collapsed={collapsed} setCollapsed={setCollapsed} />;
  }
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

  const can = (permission: string) => membership.permissions.some((item) => item === permission);
  const makeItem = (path: string, label: string, icon: IconName) => ({
    to: `/t/${tenantSlug}/${path}`,
    label,
    icon,
  });
  const navGroups: { label: string; items: ReturnType<typeof makeItem>[] }[] = [
    {
      label: "Workspace",
      items: [makeItem("overview", "Overview", "overview"), makeItem("tickets", "Tickets", "ticket")],
    },
    {
      label: "Insights",
      items: [
        ...(can("reports.view") ? [makeItem("reports", "Reports", "reports")] : []),
        ...(can("audit.view") ? [makeItem("audit", "Audit log", "audit")] : []),
        ...(can("audit.view") || can("config.manage") ? [makeItem("email-logs", "Email logs", "email")] : []),
      ],
    },
    {
      label: "Configure",
      items: [
        ...(can("config.manage") || membership.role !== "employee"
          ? [makeItem("admin", "Configuration", "admin")]
          : []),
        ...(can("users.manage") || membership.role !== "employee"
          ? [makeItem("users", "People", "people")]
          : []),
      ],
    },
  ].filter((group) => group.items.length > 0);

  return (
    <div className={`app-shell ${drawerOpen ? "drawer-open" : ""} ${collapsed ? "is-collapsed" : ""}`.trim()}>
      <aside className="sidebar" id="app-sidebar" aria-label="Main navigation">
        <div className="sb-brand">
          <BrandMark />
          <span className="sb-brand-text">
            <strong>OpsPilot</strong>
            <span>Service desk</span>
          </span>
        </div>

        <div className="ws-switch">
          <Menu
            ariaLabel="Switch workspace"
            triggerTitle={membership.name}
            triggerClassName="ws-trigger"
            label={
              <>
                <span className="ws-mark">{initials(membership.name)}</span>
                <span className="ws-meta">
                  <strong>{membership.name}</strong>
                  <small>{humanize(membership.role)}</small>
                </span>
                <Icon name="chevron" className="ws-chevs icon-sm" />
              </>
            }
          >
            {(close) => (
              <>
                <div className="menu-head">
                  <strong>Workspaces</strong>
                  <span>Switch workspace</span>
                </div>
                {memberships.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    aria-current={item.slug === tenantSlug ? "true" : undefined}
                    onClick={() => {
                      close();
                      if (item.slug !== tenantSlug) navigate(`/t/${item.slug}/tickets`);
                    }}
                  >
                    <span className="ws-mark small">{initials(item.name)}</span>
                    <span className="menu-item-label">
                      <strong>{item.name}</strong>
                      <small>{humanize(item.role)}</small>
                    </span>
                    {item.slug === tenantSlug && <Icon name="check" className="icon-sm" />}
                  </button>
                ))}
              </>
            )}
          </Menu>
        </div>

        <nav className="sb-nav">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="sb-label">{group.label}</p>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} className="sb-item" title={collapsed ? item.label : undefined}>
                  <Icon name={item.icon} />
                  <span className="sb-item-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sb-foot">
          <Menu
            ariaLabel="Account menu"
            triggerTitle={`${user.displayName} · ${humanize(membership.role)}`}
            triggerClassName="sb-account"
            label={
              <>
                <span className="avatar">{initials(user.displayName)}</span>
                <span className="account-meta">
                  <strong>{user.displayName}</strong>
                  <small>{humanize(membership.role)}</small>
                </span>
              </>
            }
          >
            {(close) => (
              <AccountMenuItems
                user={user}
                close={close}
                signOut={() => void logout().then(() => navigate("/login"))}
              />
            )}
          </Menu>
        </div>
      </aside>

      <button
        type="button"
        className="drawer-scrim"
        aria-label="Close navigation"
        tabIndex={drawerOpen ? 0 : -1}
        onClick={() => setDrawerOpen(false)}
      />

      <div className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn sb-collapse"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-controls="app-sidebar"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            <Icon name="sidebar" />
          </button>
          <button
            ref={menuBtnRef}
            type="button"
            className="icon-btn menu-btn"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="app-sidebar"
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="crumb">
            <span className="workspace-name">{membership.name}</span>
            <span className="sep workspace-sep">/</span>
            <strong>{sectionTitle(location.pathname)}</strong>
          </div>
          <div className="topbar-right">
            <span className="badge subtle role-chip">{humanize(membership.role)}</span>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <div className="topbar-account">
              <Menu
                ariaLabel="Account menu"
                triggerClassName="icon-btn"
                label={<span className="avatar">{initials(user.displayName)}</span>}
              >
                {(close) => (
                  <AccountMenuItems
                    user={user}
                    close={close}
                    signOut={() => void logout().then(() => navigate("/login"))}
                  />
                )}
              </Menu>
            </div>
          </div>
        </header>
        <main className="page">
          <ErrorBoundary fallbackTitle="Could not load view">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function StandaloneLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="standalone-shell">
      <header className="standalone-bar">
        <Link className="sb-brand" to="/">
          <BrandMark small />
          <span className="sb-brand-text">
            <strong>OpsPilot</strong>
            <span>Service desk</span>
          </span>
        </Link>
        <div className="topbar-right">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          {user && (
            <Menu
              ariaLabel="Account menu"
              triggerClassName="icon-btn"
              label={<span className="avatar">{initials(user.displayName)}</span>}
            >
              {(close) => (
                <>
                  <div className="menu-head">
                    <strong>{user.displayName}</strong>
                    <span>{user.email}</span>
                  </div>
                  <Link className="menu-item" role="menuitem" to="/account" onClick={close}>
                    <Icon name="account" />
                    Account settings
                  </Link>
                  <Link className="menu-item" role="menuitem" to="/" onClick={close}>
                    <Icon name="ticket" />
                    Back to workspace
                  </Link>
                  <div className="menu-sep" />
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      close();
                      void logout().then(() => navigate("/login"));
                    }}
                  >
                    <Icon name="logout" />
                    Sign out
                  </button>
                </>
              )}
            </Menu>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}

function NotFound() {
  return (
    <div className="center-page">
      <div className="card narrow">
        <BrandMark />
        <p className="eyebrow">404</p>
        <h1>Not found</h1>
        <p className="muted">That page does not exist.</p>
        <Link className="button" to="/">
          Back home
        </Link>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary fallbackTitle="Application error">
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/invite/:token" element={<InvitationPage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route
          path="/account"
          element={
            <StandaloneLayout>
              <AccountPage />
            </StandaloneLayout>
          }
        />
        <Route
          path="/platform"
          element={
            <StandaloneLayout>
              <PlatformPage />
            </StandaloneLayout>
          }
        />
        <Route path="/t/:tenantSlug" element={<TenantLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="tickets/:ticketId" element={<TicketDetailPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="audit" element={<AuditLogPage />} />
          <Route path="email-logs" element={<EmailLogsPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBoundary>
  );
}
