import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowLeft, CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { AuthCard } from "./auth-card";
import { AuthPageShell } from "./forgot-password-page";

/**
 * PASSWORD RESET — set a new password.
 *
 * Supabase puts a recovery token in the URL fragment and exchanges it for a
 * session. We wait for that session before allowing a change; otherwise the
 * form would silently fail for someone who opened the link directly.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;

    // The recovery link establishes a session via the URL fragment. Checking for
    // an existing session covers both that flow and an already-signed-in user.
    void supabase.auth.getSession().then(({ data }) => {
      setReady(Boolean(data.session));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password.length < 12) {
      setError("Use at least 12 characters. A passphrase is easier to remember and stronger.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Authentication is not configured");

      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw new Error(updateError.message);

      setDone(true);
      // Force a clean sign-in with the new password so no stale session lingers.
      await supabase.auth.signOut();
      setTimeout(() => navigate("/login", { replace: true }), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update your password.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthPageShell>
        <AuthCard
          icon={<CheckCircle2 className="size-5" />}
          title="Password updated"
          description="Your password has been changed. Taking you to the sign-in page…"
        >
          <Button asChild className="mt-6 w-full" variant="secondary">
            <Link to="/login">Sign in now</Link>
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (!ready) {
    return (
      <AuthPageShell>
        <AuthCard
          icon={<ShieldCheck className="size-5" />}
          title="This link is not valid"
          description="The reset link has expired or has already been used. Request a new one to continue."
        >
          <Button asChild className="mt-6 w-full">
            <Link to="/forgot-password">Request a new link</Link>
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard
        icon={<KeyRound className="size-5" />}
        title="Choose a new password"
        description="Pick something long and unique to this account."
      >
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          <Field label="New password" htmlFor="password" hint="At least 12 characters.">
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              required
            />
          </Field>

          <Field label="Confirm new password" htmlFor="confirm">
            <Input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={submitting}
              aria-invalid={confirm.length > 0 && confirm !== password}
              required
            />
          </Field>

          {error && (
            <div role="alert" className="flex gap-2.5 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--color-danger)]">{error}</p>
            </div>
          )}

          <Button type="submit" size="lg" loading={submitting}>
            Update password
          </Button>

          <Link
            to="/login"
            className="flex items-center justify-center gap-1.5 text-[12.5px] text-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to sign in
          </Link>
        </form>
      </AuthCard>
    </AuthPageShell>
  );
}
