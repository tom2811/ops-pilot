import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage, post } from "../api.js";
import { CardSkeleton, ErrorAlert } from "../components.js";
import { BrandMark } from "../ui.js";
import type { InvitationInfo } from "../types.js";

export function InvitationPage() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<InvitationInfo>(`/auth/invitations/${encodeURIComponent(token)}`)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/auth/invitations/${encodeURIComponent(token)}/accept`, {
        displayName: info?.existingUser ? undefined : displayName,
        password,
      });
      window.location.assign(info ? `/t/${info.tenantSlug}/tickets` : "/");
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  if (loading) return <CardSkeleton label="Checking invitation" />;

  return (
    <div className="center-page">
      <div className="card narrow">
        <BrandMark />
        {info ? (
          <>
            <p className="eyebrow">{info.tenantName}</p>
            <h1>You are invited</h1>
            <p className="muted">
              Join as {info.role.replace("_", " ")} with <strong>{info.email}</strong>.
            </p>
            <form className="stack" onSubmit={(event) => void accept(event)}>
              {!info.existingUser && (
                <label>
                  Display name
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    minLength={2}
                    required
                  />
                </label>
              )}
              <label>
                {info.existingUser ? "Your password" : "Choose a password"}
                <input
                  type="password"
                  autoComplete={info.existingUser ? "current-password" : "new-password"}
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              <ErrorAlert message={error} />
              <button className="button" disabled={busy} type="submit">
                {busy ? "Joining…" : "Accept invitation"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1>Invitation unavailable</h1>
            <ErrorAlert message={error} />
            <p className="muted">Ask a workspace administrator for a new invitation.</p>
            <Link className="button secondary" to="/login">Go to sign in</Link>
          </>
        )}
      </div>
    </div>
  );
}
