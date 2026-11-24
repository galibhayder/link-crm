import { describe, expect, it } from "vitest";
import { assertFetchable, assertStorableUrl, blockedIpReason, UnsafeUrlError } from "./url-safety.js";

/**
 * SSRF PROTECTION.
 *
 * The verification service fetches a URL that a user supplied, so without a guard
 * it is a request from our server to anything we can reach — including
 * `169.254.169.254`, the cloud metadata service that hands out credentials.
 *
 * These tests exist because the previous implementation had NO guard at all: it
 * called `fetch(liveUrl, { redirect: "follow" })` on whatever string was stored.
 */

const rejected = (url: string) => {
  expect(() => assertStorableUrl(url), `${url} should be rejected`).toThrow(UnsafeUrlError);
};

describe("SSRF guard — IPv4", () => {
  it("blocks loopback in every notation a parser might accept", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
      expect(blockedIpReason(ip), ip).toBeTruthy();
    }
  });

  it("blocks the cloud metadata address", () => {
    // The single most valuable SSRF target: it returns IAM credentials.
    expect(blockedIpReason("169.254.169.254")).toBeTruthy();
    expect(blockedIpReason("169.254.170.2")).toBeTruthy(); // ECS task metadata
  });

  it("blocks private ranges", () => {
    for (const ip of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1"]) {
      expect(blockedIpReason(ip), ip).toBeTruthy();
    }
  });

  it("blocks reserved, multicast, CGNAT and unspecified", () => {
    for (const ip of ["0.0.0.0", "100.64.0.1", "224.0.0.1", "240.0.0.1"]) {
      expect(blockedIpReason(ip), ip).toBeTruthy();
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "203.0.113.10"]) {
      expect(blockedIpReason(ip), ip).toBeNull();
    }
  });

  it("blocks decimal and hex encodings of loopback", () => {
    // 2130706433 and 0x7f000001 both mean 127.0.0.1. Node's URL parser
    // normalises them, and the IP check then catches the result.
    rejected("http://2130706433/");
    rejected("http://0x7f000001/");
  });
});

describe("SSRF guard — IPv6", () => {
  it("blocks loopback, unspecified, unique-local, link-local and multicast", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(blockedIpReason(ip), ip).toBeTruthy();
    }
  });

  it("blocks IPv4-mapped IPv6 pointing at an internal address", () => {
    // ::ffff:127.0.0.1 reaches 127.0.0.1 on a dual-stack host. Checking only
    // the textual form "127.0.0.1" would miss it.
    expect(blockedIpReason("::ffff:127.0.0.1")).toBeTruthy();
    expect(blockedIpReason("::ffff:7f00:1")).toBeTruthy();
    expect(blockedIpReason("::ffff:169.254.169.254")).toBeTruthy();
  });

  it("allows a public IPv6 address", () => {
    expect(blockedIpReason("2606:4700:4700::1111")).toBeNull();
  });
});

describe("SSRF guard — schemes and hostnames", () => {
  it("rejects non-HTTP schemes", () => {
    // file:// reads the local filesystem; gopher:// speaks arbitrary protocols to
    // internal services — both are classic SSRF escalation payloads.
    for (const url of [
      "file:///etc/passwd",
      "gopher://127.0.0.1:6379/_INFO",
      "ftp://example.com/x",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      rejected(url);
    }
  });

  it("rejects internal hostnames without a DNS lookup", () => {
    for (const url of [
      "http://localhost/admin",
      "http://LOCALHOST/admin",
      "http://foo.localhost/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://service.internal/",
      "http://printer.local/",
      "http://something.home.arpa/",
    ]) {
      rejected(url);
    }
  });

  it("rejects credentials in the URL", () => {
    // http://evil.com@127.0.0.1/ is the classic parser-confusion trick: a naive
    // reader sees "evil.com", the HTTP client connects to 127.0.0.1.
    rejected("http://evil.com@127.0.0.1/");
    rejected("https://user:pass@example.com/");
  });

  it("rejects malformed URLs rather than guessing", () => {
    rejected("not a url");
    rejected("");
    rejected("//example.com");
  });

  it("accepts ordinary public URLs", () => {
    for (const url of [
      "https://example.com/article",
      "https://sub.domain.example.co.uk/path?q=1#frag",
      "https://93.184.216.34/",
    ]) {
      expect(() => assertStorableUrl(url), url).not.toThrow();
    }
  });
});

describe("DNS rebinding — the address is captured, not re-resolved", () => {
  /**
   * The guard resolves a hostname and returns the addresses it validated. The
   * caller must CONNECT to one of those addresses, not re-resolve.
   *
   * This is the difference between a real guard and an advisory one: if the code
   * called `fetch(url)` after validating, fetch would resolve a second time and an
   * attacker with a TTL-0 record could answer differently — public for the check,
   * 127.0.0.1 for the connection.
   *
   * `assertFetchable` returning `addresses` is the contract the pinned request
   * relies on, so it is asserted here. The connection itself is exercised by
   * verification.integration.test.ts, where a live loopback server must be refused.
   */
  it("returns the resolved addresses for the caller to pin", async () => {
    // Skips cleanly when there is no DNS in the environment, rather than failing a
    // build for a reason unrelated to the code under test.
    let result: Awaited<ReturnType<typeof assertFetchable>>;
    try {
      result = await assertFetchable("https://example.com/");
    } catch (err) {
      if (err instanceof UnsafeUrlError && /could not resolve/.test(err.message)) {
        return; // no DNS available — the assertion below is unprovable here
      }
      throw err;
    }

    expect(result.addresses.length).toBeGreaterThan(0);
    // Whatever was returned must itself pass the blocklist — the caller connecting
    // to addresses[0] is only safe if every entry is safe.
    for (const address of result.addresses) {
      expect(blockedIpReason(address), address).toBeNull();
    }
  });

  it("returns a literal IP directly, with no lookup", async () => {
    const result = await assertFetchable("https://93.184.216.34/");
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("refuses a hostname that resolves to an internal address", async () => {
    // localhost resolves to 127.0.0.1 / ::1 without a network round-trip, so this
    // exercises the resolve-then-check path rather than the name blocklist.
    await expect(assertFetchable("http://localhost:8080/x")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
