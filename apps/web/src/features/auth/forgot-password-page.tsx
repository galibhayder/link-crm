import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ArrowLeft, CheckCircle2, Link2, MailCheck } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { APP_NAME } from "@/lib/env";
import { AuthCard } from "./auth-card";

/**
 * PASSWORD RESET — request.
 *
 * Always reports success, whether or not the address exists. Reporting "no such
 * account" would turn this form into an account-enumeration oracle, which is a
 * privacy leak about who works at the agency.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError("Enter the email address on your account.");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Authentication is not configured");

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo: `${window.location.origin}/reset-password` },
      );

      // Deliberately not surfacing resetError.message: it can reveal whether the
      // address is registered.
      if (resetError) {
        console.warn("Password reset request failed", resetError.message);
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset email.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthPageShell>
        <AuthCard
          icon={<MailCheck className="size-5" />}
          title="Check your email"
          description={`If an account exists for ${email}, a password reset link is on its way. The link expires in one hour.`}
        >
          <div className="mt-6 flex flex-col gap-4">
            <div className="flex gap-2.5 rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] p-3">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--color-success)]">
                Didn't receive it? Check your spam folder, or request another link.
              </p>
            </div>
            <Button variant="secondary" asChild>
              <Link to="/login">
                <ArrowLeft />
                Back to sign in
              </Link>
            </Button>
          </div>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard
        title="Reset your password"
        description="Enter the email address associated with your account and we'll send you a reset link."
      >
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          <Field label="Email" htmlFor="email">
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

          {error && (
            <div role="alert" className="flex gap-2.5 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--color-danger)]">{error}</p>
            </div>
          )}

          <Button type="submit" size="lg" loading={submitting}>
            Send reset link
          </Button>

          <Link
            to="/login"
            className="text-center text-[12.5px] text-muted underline-offset-4 hover:text-foreground hover:underline"
          >
            Back to sign in
          </Link>
        </form>
      </AuthCard>
    </AuthPageShell>
  );
}

/** Shared chrome for the small auth screens. */
export function AuthPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-8 flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-md bg-brand-600 text-white">
          <Link2 className="size-5" aria-hidden />
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-foreground">{APP_NAME}</span>
      </div>
      {children}
    </div>
  );
}
