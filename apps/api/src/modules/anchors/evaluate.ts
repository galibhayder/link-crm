import { ANCHOR_TARGET_RATIO, isOverOptimised } from "@crm/shared";

/**
 * ANCHOR ALERT EVALUATION.
 *
 * Extracted from the `/anchors/alerts/evaluate` route so the endpoint and the
 * scheduled anchor-alerts job share ONE implementation. Two copies would drift, and
 * the version a user sees disagreeing with the version that notifies them is worse
 * than no alert at all.
 *
 * Pure: takes the distribution rows and the configured rules, returns breaches. No
 * database access, so it is directly testable.
 */

export interface DistributionRow {
  anchor_type: string;
  link_count: number | string;
  share: number | string;
}

export interface AlertRule {
  anchor_category: string;
  max_share: number | string;
  min_share: number | string | null;
  min_links: number | string;
}

export type BreachKind = "above_max" | "below_min";

export interface Breach {
  category: string;
  share: number;
  linkCount: number;
  kind: BreachKind;
  threshold: number;
  source: "configured" | "default";
  severity: "warning" | "critical";
}

/** Categories with a meaningful healthy range. image_alt has none. */
const CHECKED_CATEGORIES = ["branded", "exact_match", "partial_match", "generic", "naked_url"] as const;

/**
 * Evaluate breaches for one scope.
 *
 * The sample floor applies to the TOTAL, not to each category. Requiring 10 links
 * *in a category* before it can be flagged is backwards: over-optimisation is
 * precisely when one category is a large share of a small total. With 13 links,
 * exact match at 15.4% is exactly the signal this report exists to catch, and a
 * per-category floor of 10 made it impossible to ever fire.
 */
export function evaluateAnchorAlerts(rows: DistributionRow[], rules: AlertRule[]): Breach[] {
  const total = rows.reduce((n, r) => n + Number(r.link_count), 0);
  const shareByCategory = new Map(rows.map((r) => [r.anchor_type, Number(r.share)]));
  const countByCategory = new Map(rows.map((r) => [r.anchor_type, Number(r.link_count)]));
  const configured = new Map(rules.map((r) => [r.anchor_category, r]));

  const breaches: Breach[] = [];

  for (const category of CHECKED_CATEGORIES) {
    const rule = configured.get(category);
    const max = rule ? Number(rule.max_share) : ANCHOR_TARGET_RATIO[category].max;
    const min = rule?.min_share != null ? Number(rule.min_share) : null;
    const minLinks = rule ? Number(rule.min_links) : 10;

    const count = countByCategory.get(category) ?? 0;
    const share = shareByCategory.get(category) ?? 0;

    // Below the sample floor a ratio is noise, not a signal.
    if (total < minLinks) continue;
    // A category with no links has no share to judge.
    if (count === 0) continue;

    if (isOverOptimised(category, share, max)) {
      breaches.push({
        category,
        share,
        linkCount: count,
        kind: "above_max",
        threshold: max,
        source: rule ? "configured" : "default",
        // Exact match is the category that actively harms rankings, so a breach
        // there is more urgent than a quiet brand share.
        severity: category === "exact_match" ? "critical" : "warning",
      });
    }

    if (min !== null && share < min) {
      breaches.push({
        category,
        share,
        linkCount: count,
        kind: "below_min",
        threshold: min,
        source: "configured",
        severity: "warning",
      });
    }
  }

  return breaches;
}

/**
 * A stable key for one breach, used to dedupe notifications.
 *
 * Includes the kind so "exact match is too high" and "exact match is too low" are
 * distinct conditions — resolving one must not suppress the other.
 */
export function breachDedupeKey(scopeId: string, breach: Breach): string {
  return `anchor_alert:${scopeId}:${breach.category}:${breach.kind}`;
}

/** A short human sentence for the notification payload. */
export function breachSummary(breach: Breach): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const label = breach.category.replace(/_/g, " ");
  return breach.kind === "above_max"
    ? `${label} anchors are ${pct(breach.share)}, above the ${pct(breach.threshold)} limit`
    : `${label} anchors are ${pct(breach.share)}, below the ${pct(breach.threshold)} minimum`;
}
