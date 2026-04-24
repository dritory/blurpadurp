// Svix webhook signature verification. Resend uses Svix for its
// webhook transport, so the same verifier handles all Resend events.
// No external dep — ~20 lines of crypto primitives.
//
// Reference: https://docs.svix.com/receiving/verifying-payloads/how-manual

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyInput {
  /** The raw request body. MUST be the byte-exact string; no re-JSON. */
  body: string;
  /** svix-id header. */
  svixId: string;
  /** svix-timestamp header (unix seconds, string). */
  svixTimestamp: string;
  /** svix-signature header, space-separated list of `v1,<base64-sig>`. */
  svixSignature: string;
  /** Signing secret from Resend, e.g. `whsec_...`. */
  secret: string;
  /** Max skew allowed between svix-timestamp and now. Default 5 min. */
  toleranceSec?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "stale" | "bad_signature" | "malformed" };

export function verifySvixSignature(input: VerifyInput): VerifyResult {
  if (
    !input.svixId ||
    !input.svixTimestamp ||
    !input.svixSignature ||
    !input.secret
  ) {
    return { ok: false, reason: "missing" };
  }

  const ts = Number(input.svixTimestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" };
  const tolerance = input.toleranceSec ?? 300;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > tolerance) return { ok: false, reason: "stale" };

  const rawSecret = input.secret.startsWith("whsec_")
    ? Buffer.from(input.secret.slice("whsec_".length), "base64")
    : Buffer.from(input.secret, "utf8");

  const signedPayload = `${input.svixId}.${input.svixTimestamp}.${input.body}`;
  const expected = createHmac("sha256", rawSecret)
    .update(signedPayload)
    .digest();

  // The header can carry multiple signatures separated by spaces; each
  // has the form `v1,<base64>`. Any match passes.
  for (const piece of input.svixSignature.split(" ")) {
    const [ver, val] = piece.split(",");
    if (ver !== "v1" || val === undefined) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(val, "base64");
    } catch {
      continue;
    }
    if (provided.length !== expected.length) continue;
    if (timingSafeEqual(provided, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}
