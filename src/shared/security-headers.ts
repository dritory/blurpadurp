// Hono middleware that applies strict-by-default security headers to
// every response. Mounted once in api/index.tsx.
//
// Header set:
// - Content-Security-Policy: neutralises any <script> the composer LLM
//   might be coaxed into emitting (e.g. via a hostile RSS title). Allows
//   only same-origin scripts — every script we ship (just /assets/wave.js
//   today) is served from our own origin. No inline <script> anywhere.
//   Inline <style> is still allowed since admin views depend on it.
//   Google Fonts allowed (Lora + Comfortaa faces) via stylesheet + font.
// - Strict-Transport-Security: belt-and-braces; Fly already adds this
//   for *.fly.dev but not custom domains by default.
// - X-Content-Type-Options: nosniff — stops browsers guessing MIME.
// - Referrer-Policy: strict-origin-when-cross-origin — citations don't
//   leak full URL paths to third-party hosts on click.
// - X-Frame-Options: DENY — already covered by frame-ancestors in CSP
//   but older browsers read this one.

import type { MiddlewareHandler } from "hono";

export interface SecurityHeadersOptions {
  /** Enable HSTS. Off on localhost to avoid locking your browser into https. */
  hsts?: boolean;
}

const CSP = [
  `default-src 'self'`,
  `base-uri 'self'`,
  `script-src 'self'`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `font-src 'self' https://fonts.gstatic.com data:`,
  `img-src 'self' data:`,
  `connect-src 'self'`,
  `frame-ancestors 'none'`,
  `form-action 'self'`,
  `object-src 'none'`,
].join("; ");

export function securityHeaders(
  opts: SecurityHeadersOptions = {},
): MiddlewareHandler {
  const hsts = opts.hsts ?? true;
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Frame-Options", "DENY");
    if (hsts) {
      c.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
  };
}
