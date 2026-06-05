import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { securityHeaders } from "./security-headers.ts";

function appWith(hsts: boolean): Hono {
  const app = new Hono();
  app.use("*", securityHeaders({ hsts }));
  app.get("/", (c) => c.text("ok"));
  return app;
}

describe("securityHeaders middleware", () => {
  test("sets the strict header set on every response", async () => {
    const res = await appWith(false).request("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("omits HSTS when disabled (localhost)", async () => {
    const res = await appWith(false).request("/");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  test("emits HSTS when enabled (production)", async () => {
    const res = await appWith(true).request("/");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});
