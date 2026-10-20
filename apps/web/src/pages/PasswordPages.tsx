import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { errorMessage, post } from "../api.js";
import { ErrorAlert } from "../components.js";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password/reset/request", { email });
      setSent(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="card narrow">
        <div className="brand-mark">OP</div>
        <p className="eyebrow">Account recovery</p>
        <h1>Reset password</h1>
        {sent ? (
          <>
            <div className="callout success">
              If an account exists for that address, a reset link has been queued. Check your inbox.
            </div>
            <Link className="button secondary" to="/login">Back to sign in</Link>
          </>
        ) : (
          <form className="stack" onSubmit={(event) => void submit(event)}>
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
            <ErrorAlert message={error} />
            <button className="button" disabled={busy} type="submit">
              {busy ? "Sending…" : "Send reset link"}
            </button>
            <Link className="small" to="/login">Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password/reset/confirm", { token, password });
      navigate("/login", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="card narrow">
        <div className="brand-mark">OP</div>
        <p className="eyebrow">Account recovery</p>
        <h1>Choose a new password</h1>
        {!token ? (
          <>
            <ErrorAlert message="This reset link is missing its token." />
            <Link className="button secondary" to="/forgot-password">Request a new link</Link>
          </>
        ) : (
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </label>
            <ErrorAlert message={error} />
            <button className="button" disabled={busy} type="submit">
              {busy ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
