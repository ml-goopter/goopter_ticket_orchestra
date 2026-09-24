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
    <main>
      <h1>Log in</h1>
      <form onSubmit={(event) => void handleSubmit(event)}>
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
        <button type="submit" disabled={submitting}>
          Log in
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
