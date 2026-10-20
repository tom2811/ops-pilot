import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, formatDate, patch, post } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, Spinner } from "../components.js";
import type { PlatformTenant } from "../types.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function PlatformPage() {
  const { user, loading, logout } = useAuth();
  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loadingTenants, setLoadingTenants] = useState(true);

  useEffect(() => {
    if (!user?.isPlatformAdmin) return;
    let cancelled = false;
    api<{ tenants: PlatformTenant[] }>("/platform/tenants")
      .then((data) => {
        if (!cancelled) setTenants(data.tenants);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingTenants(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, refresh]);

  if (loading) return <Spinner />;
  if (!user) {
    return (
      <div className="account-page">
        <div className="card narrow">
          <h1>Sign in required</h1>
          <Link className="button" to="/login">Sign in</Link>
        </div>
      </div>
    );
  }
  if (!user.isPlatformAdmin) {
    return (
      <div className="account-page">
        <div className="card narrow">
          <h1>Platform administrators only</h1>
          <p className="muted">This area manages workspaces across OpsPilot.</p>
          <Link className="button secondary" to="/">Back to workspace</Link>
        </div>
      </div>
    );
  }

  async function createTenant(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setInviteLink(null);
    try {
      const result = await post<{ invitationLink: string }>("/platform/tenants", {
        name,
        slug: slug || slugify(name),
        adminEmail,
      });
      setInviteLink(result.invitationLink);
      setNotice("Workspace created. Share the administrator invitation link.");
      setName("");
      setSlug("");
      setAdminEmail("");
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(tenant: PlatformTenant): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const status = tenant.status === "active" ? "suspended" : "active";
      await patch(`/platform/tenants/${tenant.id}`, { status });
      setNotice(`${tenant.name} ${status === "active" ? "reactivated" : "suspended"}.`);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-page">
      <div className="platform-topbar">
        <div>
          <span className="brand-mark small">OP</span>
          <strong>OpsPilot Platform</strong>
        </div>
        <nav>
          <Link to="/account">Account</Link>
          <button className="button ghost small" onClick={() => void logout()}>Sign out</button>
        </nav>
      </div>

      <PageHeader eyebrow="Platform" title="Workspaces">
        <p className="muted">Onboard tenants, provision defaults, and suspend access.</p>
      </PageHeader>
      <ErrorAlert message={error} />
      {notice && <div className="callout success">{notice}</div>}
      {inviteLink && (
        <div className="callout warning">
          <strong>Administrator invitation</strong>
          <p className="mono-break">{inviteLink}</p>
          <button
            className="button secondary small"
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink);
              setNotice("Invitation link copied.");
            }}
          >
            Copy link
          </button>
        </div>
      )}

      <div className="admin-grid">
        <section className="card">
          <div className="section-heading"><h2>New workspace</h2></div>
          <form className="stack" onSubmit={(event) => void createTenant(event)}>
            <label>
              Workspace name
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!slug) setSlug(slugify(event.target.value));
                }}
                required
              />
            </label>
            <label>
              URL slug
              <input
                value={slug}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
                pattern="[a-z0-9][a-z0-9-]*"
                required
              />
            </label>
            <label>
              Administrator email
              <input
                type="email"
                value={adminEmail}
                onChange={(event) => setAdminEmail(event.target.value)}
                required
              />
            </label>
            <button className="button" disabled={busy} type="submit">Create workspace</button>
          </form>
          <p className="muted small">
            Default teams, categories, priorities, lifecycle, SLA policies, email templates, and routing are provisioned automatically.
          </p>
        </section>

        <section className="card">
          <div className="section-heading"><h2>Portfolio</h2></div>
          {loadingTenants ? (
            <Spinner label="Loading workspaces…" />
          ) : tenants.length === 0 ? (
            <EmptyState title="No workspaces yet" />
          ) : (
            <div className="platform-stats">
              <div><strong>{tenants.length}</strong><span>Workspaces</span></div>
              <div><strong>{tenants.filter((tenant) => tenant.status === "active").length}</strong><span>Active</span></div>
              <div><strong>{tenants.reduce((total, tenant) => total + tenant.member_count, 0)}</strong><span>People</span></div>
              <div><strong>{tenants.reduce((total, tenant) => total + tenant.ticket_count, 0)}</strong><span>Tickets</span></div>
            </div>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: "1.25rem" }}>
        <div className="section-heading"><h2>All workspaces</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Workspace</th><th>Status</th><th>People</th><th>Tickets</th><th>Invites</th><th>Created</th><th />
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id}>
                  <td>
                    <strong>{tenant.name}</strong>
                    <div className="muted small">/{tenant.slug}</div>
                  </td>
                  <td><span className={`badge status-${tenant.status === "active" ? "open" : "closed"}`}>{tenant.status}</span></td>
                  <td>{tenant.member_count}</td>
                  <td>{tenant.ticket_count}</td>
                  <td>{tenant.pending_invitations}</td>
                  <td className="muted small">{formatDate(tenant.created_at)}</td>
                  <td>
                    <button className="button ghost small" disabled={busy} onClick={() => void toggleStatus(tenant)}>
                      {tenant.status === "active" ? "Suspend" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
