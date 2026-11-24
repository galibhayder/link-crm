import { useState, type FormEvent } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { AlertCircle, Link2, Monitor, Moon, Sun } from "lucide-react";
import { useAuth } from "@/providers/auth";
import { useTheme } from "@/providers/theme";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { APP_NAME } from "@/lib/env";
import { ApiError } from "@/lib/api";

export function LoginPage() {
  const { signIn, error: authError, configured } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (!email.trim() || !password) {
      setFormError("Enter your email and password.");
      return;
    }

    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_480px]">
      {/* Brand panel — hidden below lg so mobile goes straight to the form. */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-brand-900 p-10 text-white lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.13]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, #a5b4fc 0, transparent 45%), radial-gradient(circle at 80% 70%, #6366f1 0, transparent 40%)",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-md bg-white/15">
            <Link2 className="size-5" aria-hidden />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-[27px] font-semibold leading-tight tracking-tight">
            Run every campaign from prospect to live link.
          </h2>
          <p className="mt-3 text-[14px] leading-relaxed text-brand-200">
            Clients, outreach pipeline, placements, margins and invoices — in one workspace, with
            pricing visible only to the people who should see it.
          </p>
          <ul className="mt-7 space-y-2.5 text-[13.5px] text-brand-100">
            {[
              "Seven roles, permissions enforced in the database",
              "Wholesale cost separated from client pricing",
              "Live link monitoring with review flags",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-300" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11.5px] text-brand-300/70">
          © {new Date().getFullYear()} {APP_NAME}. Internal system.
        </p>
      </div>

      {/* Form panel */}
      <div className="relative flex flex-col justify-center bg-surface px-6 py-12 sm:px-12">
        <div className="absolute right-4 top-4 flex items-center gap-1 rounded-md border border-line bg-surface-sunken p-0.5">
          {(
            [
              { value: "light" as const, icon: Sun, label: "Light theme" },
              { value: "dark" as const, icon: Moon, label: "Dark theme" },
              { value: "system" as const, icon: Monitor, label: "System theme" },
            ]
          ).map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-label={label}
              // Compare against the CHOSEN theme, not the resolved one: with
              // "system" selected neither light nor dark is the active choice.
              aria-pressed={theme === value}
              className={
                "flex size-7 items-center justify-center rounded text-muted transition-colors hover:text-foreground " +
                (theme === value ? "bg-surface text-foreground shadow-sm" : "")
              }
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          ))}
        </div>

        <div className="mx-auto w-full max-w-sm">
          {/*
            The LOGIN page intentionally does not show the organisation's uploaded
            logo. It renders before any session exists, so serving the stored mark
            here would require an unauthenticated endpoint that tells anyone who
            reaches the page which agency runs this instance. The build-time
            `VITE_APP_NAME` and the static brand tile are correct for a pre-auth
            screen; the real logo appears from the first authenticated paint
            onward (sidebar, invoice PDF).
          */}
          <div className="mb-8 lg:hidden">
            <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-brand-600 text-white">
              <Link2 className="size-5" aria-hidden />
            </div>
            <p className="text-[15px] font-semibold text-foreground">{APP_NAME}</p>
          </div>

          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Sign in</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            Use your agency account to access the CRM.
          </p>

          {!configured && (
            <div className="mt-5 flex gap-2.5 rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] p-3">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-[var(--color-warning)]">
                Authentication is not configured. Set <code className="font-mono">VITE_SUPABASE_URL</code> and{" "}
                <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> in{" "}
                <code className="font-mono">apps/web/.env</code>.
              </p>
            </div>
          )}

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

            <Field label="Password" htmlFor="password">
              <div className="flex flex-col gap-1">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  required
                />
                <div className="flex justify-end">
                  <Link
                    to="/forgot-password"
                    className="text-[12px] text-muted underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
              </div>
            </Field>

            {(formError || authError) && (
              <div
                role="alert"
                className="flex gap-2.5 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
                <p className="text-[12.5px] leading-relaxed text-[var(--color-danger)]">
                  {formError ?? authError}
                </p>
              </div>
            )}

            <Button type="submit" size="lg" loading={submitting} disabled={!configured} className="mt-1">
              Sign in
            </Button>
          </form>

          <p className="mt-6 text-center text-[12px] leading-relaxed text-muted">
            Access is granted by an administrator.{" "}
            <Link to="/register" className="underline-offset-4 hover:text-foreground hover:underline">
              Have an invitation?
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
