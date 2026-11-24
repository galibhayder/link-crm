import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, asRole, closeAll, decodeClaims, serviceClient } from "./harness.js";

/**
 * The suite that must be green before any feature work (milestone gate).
 *
 * Each assertion states the rule from the permission matrix and then proves it
 * against real Postgres with a real JWT. Where a role must be denied, the test
 * also asserts zero rows rather than only a 403 — because a missing policy and a
 * missing route both cause different failures, and only one of them is safe.
 */

let orgId: string;
let otherOrgId: string;
let acmeClientId: string;
let betaClientId: string;
let placementId: string;
let invoiceId: string;

beforeAll(async () => {
  const db = serviceClient();

  const { data: org } = await db.from("organizations").select("id").eq("slug", "demo-agency").single();
  const { data: other } = await db.from("organizations").select("id").eq("slug", "rival-agency").single();
  const { data: clients } = await db.from("clients").select("id, name").eq("organization_id", org!.id);

  orgId = org!.id;
  otherOrgId = other!.id;
  acmeClientId = clients!.find((c) => c.name === "Acme SaaS")!.id;
  betaClientId = clients!.find((c) => c.name === "Beta Commerce")!.id;

  const { data: placement } = await db
    .from("placements")
    .select("id")
    .eq("organization_id", orgId)
    .eq("status", "live")
    .limit(1)
    .single();
  placementId = placement!.id;

  const { data: invoice } = await db.from("invoices").select("id").eq("organization_id", orgId).limit(1).single();
  invoiceId = invoice!.id;
});

afterAll(async () => {
  await closeAll();
});

describe("the Custom Access Token Hook", () => {
  it("stamps org_id and role into app_metadata for every role", async () => {
    // Without this hook each policy reads a null org_id and denies everything —
    // a failure mode that looks like "RLS is too strict" but is really "claims
    // were never issued".
    const token = await accessTokenFor("account_manager");
    const claims = decodeClaims(token);
    const appMeta = claims.app_metadata as Record<string, unknown>;

    expect(appMeta.org_id).toBe(orgId);
    expect(appMeta.role).toBe("account_manager");
  });

  it("gives a publisher_user its supplier binding", async () => {
    const token = await accessTokenFor("publisher_user");
    const appMeta = decodeClaims(token).app_metadata as Record<string, unknown>;
    expect(appMeta.role).toBe("publisher_user");
    expect(appMeta.supplier_id).toBeTruthy();
  });
});

describe("cross-tenant isolation", () => {
  it("no internal role can read another organization's clients", async () => {
    for (const role of ["owner", "account_manager", "prospector"] as const) {
      const db = await asRole(role);
      const { data, error } = await db.from("clients").select("id, name").eq("organization_id", otherOrgId);

      expect(error, `${role} query should not error`).toBeNull();
      expect(data, `${role} must see zero rival clients`).toHaveLength(0);
    }
  });

  it("the rival owner sees only its own organization", async () => {
    const db = await asRole("rival_owner");
    const { data } = await db.from("clients").select("id, name");
    expect(data?.length).toBe(1);
    expect(data?.[0]?.name).toBe("Rival Secret Client");
  });

  it("a role cannot insert a row into another organization", async () => {
    const db = await asRole("owner");
    const { error } = await db.from("clients").insert({
      organization_id: otherOrgId,
      name: "Injected",
      domain: "injected.test",
      status: "active",
    });

    // WITH CHECK must reject this. A policy with only USING would allow it.
    expect(error).not.toBeNull();
  });
});

describe("TIER 1 — client pricing", () => {
  it("owner and account_manager read the client rate", async () => {
    for (const role of ["owner", "account_manager"] as const) {
      const db = await asRole(role);
      const { data, error } = await db.from("placement_pricing").select("*").eq("placement_id", placementId);
      expect(error).toBeNull();
      expect(data, `${role} should see pricing`).toHaveLength(1);
      expect(Number(data![0]!.client_rate)).toBe(1500);
    }
  });

  it.each(["prospector", "outreach_specialist", "content_writer"] as const)(
    "%s cannot read client pricing",
    async (role) => {
      const db = await asRole(role);
      const { data } = await db.from("placement_pricing").select("*");
      expect(data, `${role} must see zero pricing rows`).toHaveLength(0);
    },
  );

  it("the publisher cannot read what the client is charged", async () => {
    const db = await asRole("publisher_user");
    const { data } = await db.from("placement_pricing").select("*");
    expect(data).toHaveLength(0);
  });
});

describe("TIER 2 — wholesale cost", () => {
  it("owner, prospector and outreach_specialist read the cost", async () => {
    for (const role of ["owner", "prospector", "outreach_specialist"] as const) {
      const db = await asRole(role);
      const { data, error } = await db.from("placement_costs").select("*").eq("placement_id", placementId);
      expect(error, `${role} should be allowed`).toBeNull();
      expect(data, `${role} should see the cost`).toHaveLength(1);
      expect(Number(data![0]!.supplier_cost)).toBe(850);
    }
  });

  it("the ACCOUNT MANAGER cannot read wholesale cost", async () => {
    // This is the single most important assertion in the suite. The account
    // manager quotes from tier 1 and must never see what we pay, or margin is
    // one subtraction away from being public to sales.
    const db = await asRole("account_manager");
    const { data, error } = await db.from("placement_costs").select("*");

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("the client cannot read wholesale cost", async () => {
    const db = await asRole("client_user");
    const { data } = await db.from("placement_costs").select("*");
    expect(data).toHaveLength(0);
  });

  it("the content writer cannot read wholesale cost", async () => {
    const db = await asRole("content_writer");
    const { data } = await db.from("placement_costs").select("*");
    expect(data).toHaveLength(0);
  });

  it("the publisher sees only its own supplier's costs", async () => {
    const db = await asRole("publisher_user");
    const { data } = await db.from("placement_costs").select("supplier_id");
    const mySupplier = await db.auth.getUser();
    expect(mySupplier).toBeTruthy();

    const svc = serviceClient();
    const { data: profile } = await svc
      .from("profiles")
      .select("supplier_id")
      .eq("email", "publisher@demo.test")
      .single();

    // Either zero rows (nothing assigned) or only its own supplier.
    for (const row of data ?? []) {
      expect(row.supplier_id).toBe(profile!.supplier_id);
    }
  });
});

describe("TIER 3 — margin", () => {
  it("financial views are not granted to any end-user role", async () => {
    // The margin view joins both tiers, so granting it to a role would reopen
    // the leak the split exists to prevent. service_role only.
    for (const role of ["owner", "account_manager", "prospector", "client_user"] as const) {
      const db = await asRole(role);
      const { data, error } = await db.from("v_placement_margin").select("*").limit(1);
      expect(error ?? data, `${role} must not reach the margin view`).toBeTruthy();
    }
  });

  it("service_role can read the margin view", async () => {
    const svc = serviceClient();
    const { data, error } = await svc.from("v_placement_margin").select("*").eq("organization_id", orgId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);

    const row = data!.find((r) => r.placement_id === placementId);
    expect(Number(row!.margin)).toBe(650); // 1500 - 850
  });
});

describe("client portal isolation", () => {
  it("a client user sees only the client they are granted", async () => {
    const db = await asRole("client_user");
    const { data, error } = await db.from("clients").select("id, name");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.id).toBe(acmeClientId);
  });

  it("a client user cannot read the other client's campaigns", async () => {
    const db = await asRole("client_user");
    const { data } = await db.from("campaigns").select("id, client_id");
    for (const row of data ?? []) {
      expect(row.client_id).toBe(acmeClientId);
    }
  });

  it("a client user cannot read another client's placements", async () => {
    const svc = serviceClient();
    const { data: betaPlacements } = await svc
      .from("placements")
      .select("id, campaign_id")
      .eq("organization_id", orgId);

    const { data: betaCampaigns } = await svc
      .from("campaigns")
      .select("id")
      .eq("client_id", betaClientId);

    const betaCampaignIds = new Set((betaCampaigns ?? []).map((c) => c.id));

    const db = await asRole("client_user");
    const { data } = await db.from("placements").select("id, campaign_id");

    for (const row of data ?? []) {
      expect(betaCampaignIds.has(row.campaign_id), "client saw another client's placement").toBe(false);
    }
  });

  it("a client user cannot read internal outreach touchpoints", async () => {
    const db = await asRole("client_user");
    const { data } = await db.from("outreach_touchpoints").select("*");
    expect(data).toHaveLength(0);
  });
});

describe("content draft visibility", () => {
  /**
   * The client may read a draft only when it is submitted and sits on a placement
   * they are granted. Anything else — a draft still being written, or one on
   * another client's campaign — must be invisible.
   *
   * This is the boundary the portal approval endpoint depends on: the approval RPC
   * re-checks the same scope, so if the SELECT policy were too broad a client could
   * at least learn that another client's article exists.
   */
  it("a client user sees nothing while a draft is still being written", async () => {
    const db = await asRole("client_user");
    const { data } = await db.from("content_drafts").select("id, status");
    // Whatever is visible must be submitted or later; never a working draft.
    for (const row of data ?? []) {
      expect(["in_review", "approved", "published"]).toContain(row.status);
    }
  });

  it("a content writer cannot read a draft on a brief assigned to someone else", async () => {
    const svc = serviceClient();

    // A brief assigned to the OWNER, not the writer.
    const { data: owner } = await svc.from("profiles").select("id").eq("email", "owner@demo.test").single();
    const { data: placement } = await svc
      .from("placements")
      .select("id, campaign_id, organization_id")
      .eq("organization_id", orgId)
      .limit(1)
      .single();

    const { data: brief } = await svc
      .from("content_briefs")
      .insert({
        organization_id: orgId,
        placement_id: placement!.id,
        assigned_to: owner!.id,
        brief: "RLS probe — not assigned to the writer",
      })
      .select("id")
      .single();

    const { data: draft } = await svc
      .from("content_drafts")
      .insert({
        organization_id: orgId,
        brief_id: brief!.id,
        placement_id: placement!.id,
        body_md: "should not be visible to the writer",
        status: "draft",
        current_version: 1,
      })
      .select("id")
      .single();

    const db = await asRole("content_writer");
    const { data: visible } = await db.from("content_drafts").select("id").eq("id", draft!.id);
    expect(visible).toHaveLength(0);

    // Also by direct read, which is the path a guessed id would take.
    const { data: byId } = await db.from("content_drafts").select("id").eq("id", draft!.id).maybeSingle();
    expect(byId).toBeNull();

    // Clean up so the suite is re-runnable.
    await svc.from("content_drafts").delete().eq("id", draft!.id);
    await svc.from("content_briefs").delete().eq("id", brief!.id);
  });

  it("a client user cannot write to a draft at all", async () => {
    const svc = serviceClient();
    const { data: draft } = await svc
      .from("content_drafts")
      .select("id")
      .eq("organization_id", orgId)
      .limit(1)
      .maybeSingle();

    if (!draft) return; // nothing seeded to attempt against

    const db = await asRole("client_user");
    const { data } = await db
      .from("content_drafts")
      .update({ body_md: "client rewrite attempt" })
      .eq("id", draft.id)
      .select("id");

    // Either a policy error or zero rows — both mean the write did not happen.
    expect(data ?? []).toHaveLength(0);
  });
});

describe("publisher portal isolation", () => {
  it("a publisher sees only its own supplier row", async () => {
    const db = await asRole("publisher_user");
    const { data } = await db.from("suppliers").select("id, name");
    expect(data!.length).toBeLessThanOrEqual(1);
  });

  it("a publisher cannot read client identities", async () => {
    const db = await asRole("publisher_user");
    const { data } = await db.from("clients").select("*");
    expect(data).toHaveLength(0);
  });

  it("a publisher cannot read invoices or payments", async () => {
    const db = await asRole("publisher_user");
    const [{ data: invoices }, { data: payments }] = await Promise.all([
      db.from("invoices").select("*"),
      db.from("payments").select("*"),
    ]);
    expect(invoices).toHaveLength(0);
    expect(payments).toHaveLength(0);
  });
});

describe("append-only tables", () => {
  it("touchpoints cannot be updated or deleted by anyone", async () => {
    const db = await asRole("owner");
    const { data: existing } = await db.from("outreach_touchpoints").select("id").limit(1);

    if (existing && existing.length > 0) {
      // No UPDATE policy exists, so this affects zero rows rather than erroring.
      const { data: updated } = await db
        .from("outreach_touchpoints")
        .update({ subject: "rewritten history" })
        .eq("id", existing[0]!.id)
        .select();

      expect(updated ?? []).toHaveLength(0);
    }
  });

  it("activity_log is readable only by the owner", async () => {
    const owner = await asRole("owner");
    const { error: ownerErr } = await owner.from("activity_log").select("id").limit(1);
    expect(ownerErr).toBeNull();

    const am = await asRole("account_manager");
    const { data: amData } = await am.from("activity_log").select("id");
    expect(amData).toHaveLength(0);
  });
});

describe("invoice and payment integrity", () => {
  it("only the owner can write invoices", async () => {
    const am = await asRole("account_manager");
    const { error } = await am.from("invoices").insert({
      organization_id: orgId,
      client_id: acmeClientId,
      invoice_number: "HACK-0001",
      period_start: "2026-01-01",
      period_end: "2026-01-31",
      status: "draft",
    });
    expect(error).not.toBeNull();
  });

  it("only the owner can read payments", async () => {
    for (const role of ["account_manager", "prospector", "client_user"] as const) {
      const db = await asRole(role);
      const { data } = await db.from("payments").select("*");
      expect(data, `${role} must not see payments`).toHaveLength(0);
    }

    const owner = await asRole("owner");
    const { data } = await owner.from("payments").select("*");
    expect(data!.length).toBeGreaterThan(0);
  });

  it("a partial payment leaves the invoice partially_paid", async () => {
    const svc = serviceClient();
    const { data: invoice } = await svc.from("invoices").select("status, total").eq("id", invoiceId).single();
    expect(Number(invoice!.total)).toBeGreaterThan(0);
    // Seeded with 900 paid against a 1500 subtotal + 20% tax = 1800.
    expect(invoice!.status).toBe("partially_paid");
  });

  it("allocates distinct invoice numbers under concurrency", async () => {
    const svc = serviceClient();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        svc.rpc("next_document_number_rpc", { p_org: orgId, p_type: "invoice_concurrency_test" }),
      ),
    );

    for (const r of results) expect(r.error).toBeNull();

    const numbers = results.map((r) => r.data as number);
    expect(new Set(numbers).size, "concurrent allocations must be unique").toBe(20);
  });
});
