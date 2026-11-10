import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { errorMessage } from "../api.js";
import { useAuth } from "../auth.js";
import { BrandMark } from "../ui.js";

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        <BrandMark />
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
            <Link className="small" to="/forgot-password">Forgot your password?</Link>
          </form>
        </div>
      </section>
    </div>
  );
}
