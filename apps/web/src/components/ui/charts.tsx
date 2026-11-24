import { useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * CHARTS, as hand-written SVG.
 *
 * No charting dependency. The two charts this module needs are a donut and a
 * horizontal bar; a library would add a few hundred kilobytes and its own theme
 * system for that. Inline SVG also means the charts inherit the app's CSS
 * variables, so light and dark mode work without configuring a second palette.
 *
 * ACCESSIBILITY: every chart carries a `role="img"` with a text summary, and the
 * underlying numbers are also rendered as a table below. A chart that can only be
 * read visually is not a report.
 */

export interface Slice {
  label: string;
  value: number;
  /** CSS colour or a token like "var(--color-brand-500)". */
  color: string;
}

/** Stable colours keyed by anchor category, so a category never changes hue. */
export const ANCHOR_COLORS: Record<string, string> = {
  branded: "var(--color-brand-500)",
  exact_match: "var(--color-danger)",
  partial_match: "var(--color-warning)",
  generic_or_naked: "var(--color-info)",
  unclassified: "var(--color-line-strong)",
};

/**
 * A donut chart with a centre total.
 *
 * Built from stroke-dasharray on circles rather than arc paths: each slice is one
 * circle with a dash pattern, which avoids computing arc coordinates and keeps the
 * gaps exact.
 */
export function DonutChart({
  slices,
  total,
  centreLabel,
  size = 180,
  thickness = 22,
}: {
  slices: Slice[];
  total?: number;
  centreLabel?: string;
  size?: number;
  thickness?: number;
}) {
  const sum = total ?? slices.reduce((n, s) => n + s.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  // Only slices with a value take up space; a zero slice would still draw a cap.
  const visible = slices.filter((s) => s.value > 0);

  let offset = 0;

  const summary = visible
    .map((s) => `${s.label}: ${s.value}${sum > 0 ? ` (${Math.round((s.value / sum) * 100)}%)` : ""}`)
    .join(", ");

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={summary || "No data"}
        className="-rotate-90"
      >
        {/* Track, so an empty chart still reads as a ring rather than nothing. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={thickness}
        />
        {visible.map((slice) => {
          const fraction = sum > 0 ? slice.value / sum : 0;
          const length = fraction * circumference;
          // A 1px gap between slices makes adjacent categories legible without a
          // separate separator element.
          const gap = visible.length > 1 ? Math.min(2, length * 0.1) : 0;
          const dash = Math.max(0, length - gap);
          const element = (
            <circle
              key={slice.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          );
          offset += length;
          return element;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tabular-nums text-foreground">{sum}</span>
        {centreLabel && <span className="text-[11px] text-muted">{centreLabel}</span>}
      </div>
    </div>
  );
}

/**
 * A horizontal share bar with a healthy-range band behind it.
 *
 * The band is the point: a bare percentage tells a reader nothing about whether it
 * is a problem. Showing the target range behind the bar means "42% exact match"
 * reads as alarming without a second sentence explaining why.
 */
export function ShareBar({
  label,
  share,
  target,
  value,
}: {
  label: string;
  share: number;
  target: { min: number; max: number } | null;
  value: number;
}) {
  const pct = Math.max(0, Math.min(1, share));
  const over = target ? share > target.max : false;
  const under = target ? share < target.min : false;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-foreground-soft">{label}</span>
        <span className="flex items-baseline gap-2 tabular-nums">
          <span className="text-[11.5px] text-muted">{value} links</span>
          <span
            className={cn(
              "text-[12.5px] font-semibold",
              over ? "text-[var(--color-danger)]" : under ? "text-[var(--color-warning)]" : "text-foreground",
            )}
          >
            {(pct * 100).toFixed(1)}%
          </span>
        </span>
      </div>

      <div
        className="relative h-2.5 overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`${label}: ${(pct * 100).toFixed(1)} percent${
          target ? `, healthy range ${(target.min * 100).toFixed(0)}–${(target.max * 100).toFixed(0)} percent` : ""
        }`}
      >
        {/* The healthy band, drawn behind the fill. */}
        {target && (
          <div
            className="absolute inset-y-0 bg-[var(--color-success)]/15"
            style={{ left: `${target.min * 100}%`, width: `${Math.max(0, (target.max - target.min) * 100)}%` }}
          />
        )}
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300",
            over
              ? "bg-[var(--color-danger)]"
              : under
                ? "bg-[var(--color-warning)]"
                : "bg-[var(--color-success)]",
          )}
          style={{ width: `${pct * 100}%` }}
        />
      </div>

      {target && (
        <p className="mt-1 text-[11px] text-muted">
          healthy {(target.min * 100).toFixed(0)}–{(target.max * 100).toFixed(0)}%
          {over && <span className="ml-1 font-medium text-[var(--color-danger)]">· above range</span>}
          {under && <span className="ml-1 font-medium text-[var(--color-warning)]">· below range</span>}
        </p>
      )}
    </div>
  );
}

/** A compact stacked bar, for comparing several periods or campaigns at once. */
export function StackedBar({ slices, height = 10 }: { slices: Slice[]; height?: number }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const visible = slices.filter((s) => s.value > 0);

  if (total === 0) {
    return <div className="rounded-full bg-surface-sunken" style={{ height }} aria-hidden />;
  }

  return (
    <div className="flex overflow-hidden rounded-full" style={{ height }} role="img" aria-label={slices.map((s) => `${s.label}: ${s.value}`).join(", ")}>
      {visible.map((slice) => (
        <div
          key={slice.label}
          style={{ width: `${(slice.value / total) * 100}%`, backgroundColor: slice.color }}
          title={`${slice.label}: ${slice.value}`}
        />
      ))}
    </div>
  );
}

/** Legend that pairs each colour with its number, since colour alone is not data. */
export function ChartLegend({ slices, total }: { slices: Slice[]; total: number }) {
  const ordered = useMemo(() => [...slices].sort((a, b) => b.value - a.value), [slices]);

  return (
    <ul className="space-y-1.5">
      {ordered.map((s) => (
        <li key={s.label} className="flex items-center gap-2 text-[12.5px]">
          <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-foreground-soft">{s.label}</span>
          <span className="tabular-nums text-muted">
            {s.value}
            {total > 0 && <span className="ml-1 text-[11px]">({((s.value / total) * 100).toFixed(0)}%)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
