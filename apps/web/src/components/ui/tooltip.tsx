import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={150}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Tooltips are used for the collapsed sidebar rail, where the label is otherwise
 * invisible. Radix handles the a11y wiring: aria-describedby, Escape to dismiss,
 * and pointer/keyboard interaction both.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  if (!content) return <>{children}</>;

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          className={cn(
            "z-[100] max-w-64 rounded-md border border-line bg-surface-raised px-2.5 py-1.5",
            "text-[12px] font-medium text-foreground shadow-[var(--shadow-md)]",
            "animate-in-up",
            className,
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-[var(--line)]" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
