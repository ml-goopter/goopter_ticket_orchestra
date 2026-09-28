import { useState, type FormEvent } from "react";
import { useSession } from "../auth/SessionProvider.js";

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
    <main className="page login-page">
      <div className="card login-page__card">
        <h1>Log in</h1>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="field">
            <label>
              Email
              <input
                type="email"
                value={email}
                autoComplete="username"
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
          </div>
          <div className="field">
            <label>
              Password
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
          </div>
          <button type="submit" className="primary" disabled={submitting}>
            Log in
          </button>
        </form>
        {error && (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
