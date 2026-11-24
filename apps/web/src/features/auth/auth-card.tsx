import type { ReactNode } from "react";

/** Card chrome shared by the password-reset and set-password screens. */
export function AuthCard({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="w-full max-w-md rounded-xl border border-line bg-surface p-7 shadow-[var(--shadow-md)]">
      {icon && (
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-300">
          {icon}
        </div>
      )}
      <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{title}</h1>
      {description && <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{description}</p>}
      {children}
    </div>
  );
}
