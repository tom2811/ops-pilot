import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { api, del, errorMessage, formatDate, post } from "../api.js";
import { useAuth } from "../auth.js";
import { DetailSkeleton, EmptyState, ErrorAlert, PageHeader } from "../components.js";
import { useToast } from "../ui.js";
import type { SessionInfo } from "../types.js";

export function AccountPage() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api<{ sessions: SessionInfo[] }>("/auth/sessions")
      .then((data) => {
        if (!cancelled) setSessions(data.sessions);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, refresh]);

  if (loading) return <DetailSkeleton label="Loading account" />;
  if (!user) return <Navigate to="/login" replace />;

  async function changePassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password/change", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password changed", "Other sessions were signed out.");
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await del(`/auth/sessions/${id}`);
      setSessions((current) => current.filter((session) => session.id !== id));
      toast.success("Session signed out.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await del("/auth/sessions");
      toast.success("Other sessions signed out.");
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-page">
      <PageHeader eyebrow="Account" title="Your account">
        <p className="muted">
          Signed in as {user.email}. <Link to="/">Back to workspace</Link>
        </p>
      </PageHeader>
      <ErrorAlert message={error} />

      <div className="admin-grid">
        <section className="card">
          <div className="section-heading"><h2>Change password</h2></div>
          <form className="stack" onSubmit={(event) => void changePassword(event)}>
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </label>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </label>
            <button className="button" disabled={busy} type="submit">Update password</button>
          </form>
        </section>

        <section className="card">
          <div className="section-heading">
            <h2>Active sessions</h2>
            <button className="button ghost small" disabled={busy} onClick={() => void revokeOthers()}>
              Sign out others
            </button>
          </div>
          {sessionsLoading ? (
            <div className="skeleton-stack" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <div key={index} className="session-skeleton">
                  <span className="skeleton" style={{ width: "46%" }} />
                  <span className="skeleton" style={{ width: "68%", height: 8 }} />
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <EmptyState title="No sessions" />
          ) : (
            <ul className="session-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <div>
                    <strong>{session.is_current ? "This device" : (session.user_agent || "Unknown device")}</strong>
                    <p className="muted small">
                      Last active {formatDate(session.last_seen_at)}
                      {session.ip ? ` · ${session.ip}` : ""}
                    </p>
                  </div>
                  {!session.is_current && (
                    <button
                      className="button ghost small"
                      disabled={busy}
                      onClick={() => void revoke(session.id)}
                    >
                      Sign out
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
