import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { errorMessage } from "../api.js";
import { useAuth } from "../auth.js";

const DEMO_ACCOUNTS = [
  { label: "Acme agent", email: "agent@acme.test", hint: "queue, assignment, lifecycle" },
  { label: "Acme admin", email: "admin@acme.test", hint: "workspace configuration" },
  { label: "Acme employee", email: "employee@acme.test", hint: "requester view" },
];

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("agent@acme.test");
  const [password, setPassword] = useState("Passw0rd!");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !busy) navigate("/", { replace: true });
  }, [user, busy, navigate]);

  if (loading) return null;
  if (user && !busy) return <Navigate to="/" replace />;

  async function signIn(nextEmail = email, nextPassword = password): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await login(nextEmail, nextPassword);
      navigate("/", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    void signIn();
  }

  return (
    <div className="login-page">
      <section className="login-hero">
        <div className="brand-mark">OP</div>
        <p className="eyebrow">Multi-tenant service desk</p>
        <h1>Support work, without the noise.</h1>
        <p>
          OpsPilot gives every customer a bounded workspace: its own people, queues, fields and automation.
          One shared database, enforced isolation, visible audit trails.
        </p>
        <ul className="hero-points">
          <li>Tenant isolation enforced in PostgreSQL</li>
          <li>Configurable routing and custom fields</li>
          <li>Reliable automation handoff with idempotent commands</li>
        </ul>
      </section>

      <section className="login-panel">
        <div className="card">
          <p className="eyebrow">Welcome back</p>
          <h2>Sign in</h2>
          <form onSubmit={onSubmit} className="stack">
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error && <div className="alert error">{error}</div>}
            <button className="button" disabled={busy} type="submit">
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="demo-accounts">
            <p className="muted small">Demo password: Passw0rd!</p>
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                className="demo-account"
                disabled={busy}
                onClick={() => {
                  setEmail(account.email);
                  setPassword("Passw0rd!");
                  void signIn(account.email, "Passw0rd!");
                }}
              >
                <span>{account.label}</span>
                <span className="muted small">{account.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
