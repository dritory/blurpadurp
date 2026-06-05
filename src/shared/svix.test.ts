import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySvixSignature } from "./svix.ts";

// Build a valid Svix signature for a payload, mirroring the sender side.
function sign(opts: {
  id: string;
  ts: string;
  body: string;
  secret: string; // raw (no whsec_)
}): string {
  const key = Buffer.from(opts.secret, "base64");
  const sig = createHmac("sha256", key)
    .update(`${opts.id}.${opts.ts}.${opts.body}`)
    .digest("base64");
  return `v1,${sig}`;
}

const SECRET_RAW = Buffer.from("super-secret-key").toString("base64");
const SECRET = `whsec_${SECRET_RAW}`;

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifySvixSignature", () => {
  test("accepts a correctly-signed payload", () => {
    const id = "msg_1";
    const ts = nowTs();
    const body = '{"type":"email.bounced"}';
    const svixSignature = sign({ id, ts, body, secret: SECRET_RAW });
    expect(
      verifySvixSignature({
        body,
        svixId: id,
        svixTimestamp: ts,
        svixSignature,
        secret: SECRET,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a tampered body", () => {
    const id = "msg_1";
    const ts = nowTs();
    const svixSignature = sign({ id, ts, body: "original", secret: SECRET_RAW });
    const r = verifySvixSignature({
      body: "tampered",
      svixId: id,
      svixTimestamp: ts,
      svixSignature,
      secret: SECRET,
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a stale timestamp", () => {
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000) - 10_000);
    const body = "x";
    const svixSignature = sign({ id, ts, body, secret: SECRET_RAW });
    expect(
      verifySvixSignature({
        body,
        svixId: id,
        svixTimestamp: ts,
        svixSignature,
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  test("reports missing headers", () => {
    expect(
      verifySvixSignature({
        body: "x",
        svixId: "",
        svixTimestamp: nowTs(),
        svixSignature: "v1,abc",
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });

  test("reports a non-numeric timestamp as malformed", () => {
    expect(
      verifySvixSignature({
        body: "x",
        svixId: "msg_1",
        svixTimestamp: "not-a-number",
        svixSignature: "v1,abc",
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  test("accepts when any one of several space-separated sigs matches", () => {
    const id = "msg_1";
    const ts = nowTs();
    const body = "payload";
    const good = sign({ id, ts, body, secret: SECRET_RAW });
    const svixSignature = `v1,AAAA ${good} v2,ignored`;
    expect(
      verifySvixSignature({
        body,
        svixId: id,
        svixTimestamp: ts,
        svixSignature,
        secret: SECRET,
      }),
    ).toEqual({ ok: true });
  });
});
