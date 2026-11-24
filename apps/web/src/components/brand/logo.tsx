import { Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ORGANISATION LOGO.
 *
 * The mark comes from `organizations.logo_url`, which is seeded from the real
 * Trivero asset and editable in the Admin panel. It is the same value the invoice
 * PDF reads, so the app and the invoices a client receives can never disagree.
 *
 * The fallback matters as much as the image: a fresh organisation with no logo
 * must still look deliberate, so it renders the same rounded brand tile with a
 * Lucide glyph that shipped before this phase. Nothing here should ever produce a
 * broken-image icon.
 */

export interface BrandLogoProps {
  /** The `logo_url` value: a data URI, an absolute URL, or null. */
  src?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Accessible name. Omitted means decorative, which is right when the app name sits beside it. */
  alt?: string;
}

const SIZES = {
  sm: { box: "size-7 rounded-md", icon: "size-4", pad: "p-1" },
  md: { box: "size-8 rounded-md", icon: "size-[18px]", pad: "p-1" },
  lg: { box: "size-11 rounded-lg", icon: "size-5", pad: "p-1.5" },
} as const;

export function BrandLogo({ src, size = "md", className, alt }: BrandLogoProps) {
  const s = SIZES[size];

  // A logo is stored as a data URI, but an absolute URL is also accepted so an
  // organisation can point at their own CDN instead of uploading.
  const usable = typeof src === "string" && src.trim().length > 0;

  if (!usable) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center bg-brand-600 text-white",
          s.box,
          className,
        )}
        aria-hidden
      >
        <Link2 className={s.icon} />
      </span>
    );
  }

  return (
    <span
      className={cn(
        // A white tile behind the mark: the Trivero logo is a dark/blue gradient on
        // transparent, and on a dark surface it would otherwise lose contrast.
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-black/5",
        s.box,
        s.pad,
        className,
      )}
    >
      <img
        src={src}
        alt={alt ?? ""}
        aria-hidden={alt ? undefined : true}
        className="size-full object-contain"
        // A stored logo that fails to render (corrupt bytes, revoked URL) must not
        // leave an empty tile. Hiding the image falls back to the tile's white
        // background rather than a broken-image glyph.
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
        }}
      />
    </span>
  );
}
