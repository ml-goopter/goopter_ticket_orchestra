import { useState, type FormEvent } from "react";
import { useSession } from "../auth/SessionProvider.js";
import "./login.css";

/**
 * Email/password login (design.md §13, D9). Success flips `SessionProvider`
 * to `authenticated`; the router (`LoginRoute` in router.tsx) then redirects
 * to `?next=` or `/`.
 */
export function LoginPage() {
  const { login, error } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await login(email, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-page__wrap">
        <div className="login-page__brand">
          <div className="login-page__brand-mark">O</div>
          Orchestra
        </div>
        <div className="card login-page__card">
          <h1>Log in</h1>
          <p className="login-page__subtitle">Jira tickets to reviewed pull requests.</p>
          {error && (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          )}
          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                autoComplete="username"
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <button type="submit" className="primary" disabled={submitting}>
              Log in
            </button>
          </form>
        </div>
        <p className="login-page__footer">Accounts are created by an admin.</p>
      </div>
    </main>
  );
}
