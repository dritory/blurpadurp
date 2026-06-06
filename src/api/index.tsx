// Hono app: public archive, subscription endpoints, preference pages.
// No accounts — subscription is the identity. All routes are public.

import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { getEnvOptional } from "../shared/env.ts";
import {
  clientIp,
  makeRateLimiter,
} from "../shared/rate-limit.ts";
import { securityHeaders } from "../shared/security-headers.ts";
import { NotFoundPage, ServerErrorPage } from "../views/error-pages.tsx";
import { registerAdminRoutes } from "./admin.tsx";
import { registerPublicRoutes } from "./public.tsx";
import { registerFeedRoutes } from "./feeds.tsx";
import { registerSubscriptionRoutes } from "./subscription.tsx";

// Coarse per-IP limiter shared across the signed-token routes (/confirm,
// /unsubscribe, /manage, /draft). HMAC verification is already
// constant-time, so these aren't an enumeration vector — this is cheap noise
// control against a script hammering them. Generous: 20 burst, refill 1 per
// 5s (= 720/hour sustained).
const tokenRouteLimiter = makeRateLimiter({
  capacity: 20,
  refillPerMs: 1 / 5_000,
});

export const app = new Hono();

// Strict security headers (static CSP, nosniff, frame-deny, HSTS).
// Applied globally so admin pages benefit too. HSTS off on localhost —
// turn it on for anything with a trusted HTTPS cert.
app.use(
  "*",
  securityHeaders({
    hsts: getEnvOptional("NODE_ENV") === "production",
  }),
);

// Static assets live in ./public — served under /assets/*. Safe to cache
// aggressively; the logo and any supporting files are version-agnostic.
app.use(
  "/assets/*",
  serveStatic({
    root: "./public",
    rewriteRequestPath: (path) => path.replace(/^\/assets\//, "/"),
  }),
);

// Coarse per-IP throttle on the signed-token routes. Registered before the
// handlers so it wraps them. A tripped bucket returns a plain 429 rather
// than a branded page — these aren't reader-facing happy paths.
const tokenRouteGuard = async (
  c: Context,
  next: () => Promise<void>,
): Promise<Response | void> => {
  const ip = clientIp(c.req.raw.headers, null);
  if (!tokenRouteLimiter.take(ip)) {
    return c.text("Too many requests. Please slow down.", 429);
  }
  await next();
};
app.use("/confirm/*", tokenRouteGuard);
app.use("/unsubscribe/*", tokenRouteGuard);
app.use("/manage/*", tokenRouteGuard);
app.use("/draft/*", tokenRouteGuard);


registerPublicRoutes(app);

const adminUser = getEnvOptional("ADMIN_USER") ?? "admin";
const adminPassword = getEnvOptional("ADMIN_PASSWORD");

if (adminPassword !== undefined && adminPassword.length > 0) {
  app.use(
    "/admin/*",
    basicAuth({ username: adminUser, password: adminPassword }),
  );

  registerAdminRoutes(app);
} else {
  app.all("/admin/*", (c) =>
    c.text(
      "Admin disabled. Set ADMIN_PASSWORD in the environment to enable.",
      503,
    ),
  );
}

registerFeedRoutes(app);
registerSubscriptionRoutes(app);

app.notFound((c) => c.html(<NotFoundPage />, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("[api]", err);
  // Fail safe: never leak stack traces / internal paths to the client by
  // default — a missing or misspelled NODE_ENV in prod must not flip this
  // open. The full error is always on the server console above; set
  // BLURPADURP_DEBUG_ERRORS=1 to also surface it in the browser locally.
  const detail =
    getEnvOptional("BLURPADURP_DEBUG_ERRORS") === "1"
      ? err instanceof Error
        ? err.stack ?? err.message
        : String(err)
      : undefined;
  return c.html(<ServerErrorPage detail={detail} />, 500);
});

// Run directly: `bun run src/api/index.ts`
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  // Bind to 0.0.0.0 so Fly's proxy (and any container runtime) can
  // reach the socket. Bun.serve defaults to localhost otherwise, which
  // is invisible from outside the machine's network namespace.
  const hostname = "0.0.0.0";
  console.log(`listening on http://${hostname}:${port}`);
  Bun.serve({ port, hostname, fetch: app.fetch });
}
