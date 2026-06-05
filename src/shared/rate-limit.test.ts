import { describe, expect, test } from "bun:test";
import { clientIp, makeRateLimiter, withinCooldown } from "./rate-limit.ts";

describe("rate-limit token bucket", () => {
  test("allows up to capacity, then denies", () => {
    const rl = makeRateLimiter({ capacity: 3, refillPerMs: 0 });
    expect(rl.take("ip1")).toBe(true);
    expect(rl.take("ip1")).toBe(true);
    expect(rl.take("ip1")).toBe(true);
    expect(rl.take("ip1")).toBe(false);
  });

  test("different keys have independent buckets", () => {
    const rl = makeRateLimiter({ capacity: 1, refillPerMs: 0 });
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    expect(rl.take("b")).toBe(true);
  });

  test("refills over time", async () => {
    const rl = makeRateLimiter({ capacity: 1, refillPerMs: 1 / 100 });
    expect(rl.take("k")).toBe(true);
    expect(rl.take("k")).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(rl.take("k")).toBe(true);
  });
});

describe("global confirmation-send cap (fixed-key bucket)", () => {
  test("a fixed key drains one shared budget regardless of caller", () => {
    // The /subscribe global cap keys every send on one string so distinct
    // IPs/addresses can't each get their own bucket.
    const rl = makeRateLimiter({ capacity: 2, refillPerMs: 0 });
    expect(rl.take("confirmation-send")).toBe(true);
    expect(rl.take("confirmation-send")).toBe(true);
    expect(rl.take("confirmation-send")).toBe(false);
  });
});

describe("withinCooldown", () => {
  test("null lastAt is never in cooldown", () => {
    expect(withinCooldown(null, 1000, 5000)).toBe(false);
  });

  test("inside the window is in cooldown", () => {
    expect(withinCooldown(new Date(4500), 1000, 5000)).toBe(true);
  });

  test("at or past the window is not in cooldown", () => {
    expect(withinCooldown(new Date(4000), 1000, 5000)).toBe(false);
    expect(withinCooldown(new Date(3000), 1000, 5000)).toBe(false);
  });
});

describe("clientIp", () => {
  test("prefers the trusted Fly-Client-IP over a spoofable XFF", () => {
    const h = new Headers({
      "fly-client-ip": "5.5.5.5",
      "x-forwarded-for": "1.2.3.4, 10.0.0.1",
    });
    expect(clientIp(h)).toBe("5.5.5.5");
  });

  test("prefers CF-Connecting-IP over XFF when no Fly header", () => {
    const h = new Headers({
      "cf-connecting-ip": "6.6.6.6",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(clientIp(h)).toBe("6.6.6.6");
  });

  test("falls back to X-Forwarded-For first entry", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" });
    expect(clientIp(h)).toBe("1.2.3.4");
  });

  test("falls back to X-Real-IP", () => {
    const h = new Headers({ "x-real-ip": "9.9.9.9" });
    expect(clientIp(h)).toBe("9.9.9.9");
  });

  test("falls back to provided remote", () => {
    expect(clientIp(new Headers(), "127.0.0.1")).toBe("127.0.0.1");
  });

  test("returns 'unknown' when nothing available", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
