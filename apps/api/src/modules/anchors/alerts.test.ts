import { describe, expect, it } from "vitest";
import { ANCHOR_TARGET_RATIO, isOverOptimised } from "@crm/shared";

/**
 * ALERT EVALUATION LOGIC.
 *
 * The endpoint's rule, reduced to a pure function so it can be tested without a
 * database: given per-category counts and a total, which categories breach?
 *
 * The bug this pins: the sample floor was applied PER CATEGORY, so a category
 * could never breach unless it alone held 10 links. Over-optimisation is precisely
 * when one category dominates a small total, so the floor made the alert
 * permanently silent — the report showed a red bar and "no alerts firing" beside
 * it.
 */

interface Row {
  anchor_type: string;
  link_count: number;
  share: number;
}

const CATEGORIES = ["branded", "exact_match", "partial_match", "generic", "naked_url"] as const;

/** Mirrors the endpoint's evaluation, including the floor semantics. */
function evaluate(rows: Row[], minLinks = 10) {
  const total = rows.reduce((n, r) => n + Number(r.link_count), 0);
  const shareBy = new Map(rows.map((r) => [r.anchor_type, Number(r.share)]));
  const countBy = new Map(rows.map((r) => [r.anchor_type, Number(r.link_count)]));

  const breaches: string[] = [];
  for (const category of CATEGORIES) {
    const count = countBy.get(category) ?? 0;
    const share = shareBy.get(category) ?? 0;

    // The floor is on the TOTAL, not the category.
    if (total < minLinks) continue;
    if (count === 0) continue;

    if (isOverOptimised(category, share, ANCHOR_TARGET_RATIO[category].max)) {
      breaches.push(category);
    }
  }
  return { total, breaches };
}

describe("alert evaluation — the sample floor", () => {
  it("flags a small category in a small total, which the per-category floor missed", () => {
    // 13 links, exact match 15.4% (2 links) against a 15% ceiling. This is the
    // exact case that reported "no alerts firing".
    const rows: Row[] = [
      { anchor_type: "branded", link_count: 4, share: 0.3077 },
      { anchor_type: "partial_match", link_count: 4, share: 0.3077 },
      { anchor_type: "generic", link_count: 3, share: 0.2308 },
      { anchor_type: "exact_match", link_count: 2, share: 0.1538 },
    ];
    const { breaches } = evaluate(rows);
    expect(breaches).toContain("exact_match");
    expect(breaches).toContain("partial_match");
  });

  it("stays silent below the total floor, where a ratio is noise", () => {
    // Three links total: any share is meaningless.
    const rows: Row[] = [
      { anchor_type: "exact_match", link_count: 2, share: 0.6667 },
      { anchor_type: "branded", link_count: 1, share: 0.3333 },
    ];
    expect(evaluate(rows, 10).breaches).toEqual([]);
  });

  it("ignores an absent category rather than treating 0/0 as a breach", () => {
    // A profile with only partial match, all within range. The categories that
    // simply have no rows must not be reported as breaching.
    const rows: Row[] = [
      { anchor_type: "partial_match", link_count: 20, share: 1 },
    ];
    // partial_match ceiling is 30%, so 100% DOES breach — that is correct. What
    // matters here is that no *other* category appears in the list.
    expect(evaluate(rows).breaches).toEqual(["partial_match"]);
  });
});

describe("alert evaluation — thresholds", () => {
  it("does not flag a share exactly at the ceiling", () => {
    // exact_match 3/20 = 15%, exactly its ceiling. The other categories must also
    // be in range, or they would appear in the breach list and mask the assertion.
    const rows: Row[] = [
      { anchor_type: "exact_match", link_count: 3, share: 0.15 },
      { anchor_type: "branded", link_count: 8, share: 0.4 },
      { anchor_type: "partial_match", link_count: 5, share: 0.25 },
      { anchor_type: "generic", link_count: 3, share: 0.15 },
      { anchor_type: "naked_url", link_count: 1, share: 0.05 },
    ];
    expect(evaluate(rows).breaches).toEqual([]);
  });

  it("flags a share just above the ceiling", () => {
    const rows: Row[] = [
      { anchor_type: "exact_match", link_count: 4, share: 0.16 },
      { anchor_type: "branded", link_count: 21, share: 0.84 },
    ];
    expect(evaluate(rows).breaches).toContain("exact_match");
  });

  it("flags an over-brand-heavy profile against the false-positive side too", () => {
    // Branded above 50% is not an SEO penalty, but the report still surfaces it,
    // because a client whose anchors are nearly all brand is not building anything.
    const rows: Row[] = [
      { anchor_type: "branded", link_count: 19, share: 0.95 },
      { anchor_type: "generic", link_count: 1, share: 0.05 },
    ];
    expect(evaluate(rows).breaches).toContain("branded");
  });
});
