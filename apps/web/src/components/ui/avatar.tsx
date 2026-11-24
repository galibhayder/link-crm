import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn, initialsOf } from "@/lib/utils";

export function Avatar({
  name,
  email,
  src,
  size = "md",
  className,
}: {
  name?: string | null;
  email?: string | null;
  src?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = {
    xs: "size-6 text-[10px]",
    sm: "size-8 text-[11px]",
    md: "size-9 text-[12px]",
    lg: "size-11 text-sm",
  } as const;

  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex shrink-0 overflow-hidden rounded-full border border-line",
        sizes[size],
        className,
      )}
    >
      {src && <AvatarPrimitive.Image src={src} alt="" className="aspect-square size-full object-cover" />}
      <AvatarPrimitive.Fallback
        delayMs={src ? 200 : 0}
        className={cn(
          "flex size-full items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700",
          "dark:bg-brand-900/50 dark:text-brand-300",
        )}
      >
        {initialsOf(name, email)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
