import { describe, expect, it } from "vitest";
import { anchorDistribution, centsToNumeric, computeMargin, formatCents, fromCents, invoiceTotals, lineAmountCents, toCents } from "../src/money.js";

describe("cents conversion", () => {
  it("rounds half away from zero at the cent", () => {
    expect(toCents(10.005)).toBe(1001);
    expect(toCents(10.004)).toBe(1000);
    expect(toCents(-10.005)).toBe(-1001);
  });

  it("treats null, undefined and empty string as zero", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
  });

  it("round-trips through numeric strings without drift", () => {
    expect(centsToNumeric(toCents("1234.56"))).toBe("1234.56");
    expect(fromCents(toCents(0.1 + 0.2))).toBe(0.3);
  });

  it("formats currency", () => {
    expect(formatCents(150000)).toBe("$1,500.00");
  });
});

describe("margin", () => {
  it("computes per-placement margin", () => {
    const m = computeMargin(300, 120);
    expect(m.marginCents).toBe(18000);
    expect(m.marginPct).toBeCloseTo(0.6, 5);
    expect(m.markupPct).toBeCloseTo(1.5, 5);
  });

  it("returns a negative margin when cost exceeds price", () => {
    const m = computeMargin(100, 150);
    expect(m.marginCents).toBe(-5000);
    expect(m.marginPct).toBeCloseTo(-0.5, 5);
  });

  it("is 0-safe when the client rate is zero", () => {
    expect(computeMargin(0, 50).marginPct).toBe(0);
  });

  it("reports null markup on zero cost rather than Infinity", () => {
    expect(computeMargin(100, 0).markupPct).toBeNull();
  });
});

describe("invoice arithmetic", () => {
  it("computes line amounts from quantity and unit price", () => {
    expect(lineAmountCents(3, toCents(100))).toBe(30000);
    expect(lineAmountCents(1.5, toCents(100))).toBe(15000);
  });

  it("sums subtotal and applies tax once", () => {
    const t = invoiceTotals([toCents(100), toCents(200)], 10);
    expect(t.subtotalCents).toBe(30000);
    expect(t.taxAmountCents).toBe(3000);
    expect(t.totalCents).toBe(33000);
  });

  it("rounds tax at the cent, not per line", () => {
    const t = invoiceTotals([toCents(0.33), toCents(0.33), toCents(0.33)], 10);
    expect(t.taxAmountCents).toBe(10); // 9.9c -> 10c, not 3 x 0.33c
  });
});

describe("anchor distribution", () => {
  it("returns shares summing to 1", () => {
    const d = anchorDistribution({ branded: 30, exact_match: 10, partial_match: 20 });
    expect(d.branded).toBeCloseTo(0.5, 5);
    expect(Object.values(d).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("is empty-safe", () => {
    expect(anchorDistribution({})).toEqual({});
  });
});
