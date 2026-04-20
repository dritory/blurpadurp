import { describe, expect, test } from "bun:test";
import { clientIp, makeRateLimiter } from "./rate-limit.ts";

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

describe("clientIp", () => {
  test("prefers X-Forwarded-For first entry", () => {
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
