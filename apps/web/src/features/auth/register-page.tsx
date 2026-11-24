import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, CheckCircle2, MailQuestion, UserPlus } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { AuthCard } from "./auth-card";
import { AuthPageShell } from "./forgot-password-page";

/**
 * REGISTRATION — invitation only.
 *
 * There is deliberately no "choose your role" control. The role is fixed by the
 * administrator's invitation and read server-side during provisioning (see
 * migration 0006). A sign-up without a pending invitation creates an auth user
 * with NO profile, and every endpoint then rejects them.
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If someone arrives from an invite email, Supabase puts the address in the
  // URL or the fragment; pre-fill it so they cannot mistype it into a mismatch.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invited = params.get("email");
    if (invited) setEmail(invited);
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!fullName.trim()) return setError("Enter your full name.");
    if (!email.trim()) return setError("Enter your email address.");
    if (password.length < 12) {
      return setError("Use a password of at least 12 characters.");
    }

    setSubmitting(true);
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Authentication is not configured");

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        // full_name is display data only. The role is NEVER sent from here.
        options: { data: { full_name: fullName.trim() } },
      });

      if (signUpError) throw new Error(signUpError.message);

      if (!data.session) {
        // Email confirmation is on: no session yet.
        setDone(true);
        return;
      }

      // A session means the account exists. Whether it has a profile depends on
      // the invitation; the app will tell them at sign-in if it does not.
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create your account.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthPageShell>
        <AuthCard
          icon={<CheckCircle2 className="size-5" />}
          title="Confirm your email"
          description={`We sent a confirmation link to ${email}. Open it to activate your account, then sign in.`}
        >
          <Button asChild className="mt-6 w-full" variant="secondary">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard
        icon={<UserPlus className="size-5" />}
        title="Accept your invitation"
        description="Use the email address your administrator invited. Your role and client access are set by them."
      >
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          <Field label="Full name" htmlFor="fullName">
            <Input
              id="fullName"
              name="fullName"
              autoComplete="name"
              placeholder="Alex Morgan"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
              required
            />
          </Field>

          <Field label="Invited email" htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@agency.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              required
            />
          </Field>

          <Field label="Password" htmlFor="password" hint="At least 12 characters.">
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

          {error && (
            <div role="alert" className="flex gap-2.5 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--color-danger)]">{error}</p>
            </div>
          )}

          <Button type="submit" size="lg" loading={submitting}>
            Create account
          </Button>

          <div className="flex gap-2.5 rounded-md bg-surface-sunken p-3">
            <MailQuestion className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <p className="text-[12px] leading-relaxed text-muted">
              No invitation? Ask your agency administrator — accounts cannot be created without one.
            </p>
          </div>

          <Link
            to="/login"
            className="text-center text-[12.5px] text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            Already have an account? Sign in
          </Link>
        </form>
      </AuthCard>
    </AuthPageShell>
  );
}
