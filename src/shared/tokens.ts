// Signed tokens for confirm / unsubscribe / preference links.
// Stateless: everything needed to verify lives in the token, signed
// with BLURPADURP_TOKEN_SECRET. No login anywhere — the token IS the
// authorization to act on a specific subscription.
//
// Format: <base64url(payload)>.<base64url(hmac)>
// Payload shape: { k: kind, id: subscription_id, e: expiry_unix }.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env.ts";

export type TokenKind = "confirm-email" | "unsubscribe-email" | "manage-email";

export interface TokenPayload {
  kind: TokenKind;
  subscriptionId: number;
  expiresAt: Date;
}

const DEFAULT_TTL_MS: Record<TokenKind, number> = {
  "confirm-email": 14 * 24 * 60 * 60 * 1000, // 14 days
  "unsubscribe-email": 365 * 24 * 60 * 60 * 1000, // 1 year
  "manage-email": 30 * 24 * 60 * 60 * 1000, // 30 days
};

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function hmac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signToken(params: {
  kind: TokenKind;
  subscriptionId: number;
  ttlMs?: number;
}): string {
  const secret = getEnv("BLURPADURP_TOKEN_SECRET");
  const ttl = params.ttlMs ?? DEFAULT_TTL_MS[params.kind];
  const payload = {
    k: params.kind,
    id: params.subscriptionId,
    e: Math.floor((Date.now() + ttl) / 1000),
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(hmac(secret, body));
  return `${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyToken(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  const secret = getEnv("BLURPADURP_TOKEN_SECRET");
  const expected = hmac(secret, body);
  let provided: Buffer;
  try {
    provided = b64urlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed: { k: unknown; id: unknown; e: unknown };
  try {
    parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const k = parsed.k;
  const id = parsed.id;
  const e = parsed.e;
  if (
    typeof k !== "string" ||
    !["confirm-email", "unsubscribe-email", "manage-email"].includes(k) ||
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof e !== "number" ||
    !Number.isFinite(e)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = new Date(e * 1000);
  if (expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    payload: { kind: k as TokenKind, subscriptionId: id, expiresAt },
  };
}
