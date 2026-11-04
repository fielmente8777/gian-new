import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { decodeJwt, decodeProtectedHeader } from "jose";

import { InvalidTokenError, TokenExpiredError } from "../errors/auth.errors.js";
import { LegacyTokenService } from "../services/legacy-token.service.js";
import { TokenService } from "../services/token.service.js";
import type { AccessClaims } from "../types/auth.types.js";
import { LEGACY_SECRET, testAuthConfig } from "./fakes.js";

const claims: AccessClaims = {
  sub: "65f000000000000000000001",
  sid: "session-1",
  ndid: "ndid-1",
  email: "owner@hotel.test",
  role: "superadmin",
  admin: true,
  perms: ["bookingEngine", "cms"],
  props: [{ hid: "20272036", perms: ["cms"] }],
  staff: false,
};

describe("TokenService (RS256 access tokens)", () => {
  const tokens = new TokenService(testAuthConfig());

  it("round-trips the claims and sets iss, aud, kid", async () => {
    const { token, expiresAt } = await tokens.signAccessToken(claims);
    assert.deepEqual(await tokens.verifyAccessToken(token), claims);
    assert.equal(decodeProtectedHeader(token).kid, "test-1");
    const payload = decodeJwt(token);
    assert.equal(payload.iss, "https://api.eazotel.com");
    assert.equal(payload.aud, "eazotel-app");
    assert.ok(Math.abs(expiresAt.getTime() - (Date.now() + 15 * 60_000)) < 5_000);
  });

  it("rejects a token for another audience", async () => {
    const { token } = await tokens.signAccessToken(claims, { audience: "some-other-api" });
    await assert.rejects(tokens.verifyAccessToken(token), InvalidTokenError);
  });

  it("rejects a tampered payload", async () => {
    const { token } = await tokens.signAccessToken(claims);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(token), admin: true, ndid: "someone-else" })).toString(
      "base64url",
    );
    await assert.rejects(tokens.verifyAccessToken(`${header}.${forged}.${signature}`), InvalidTokenError);
  });

  it("rejects an expired token with TOKEN_EXPIRED", async () => {
    const shortLived = new TokenService(testAuthConfig({ AUTH_ACCESS_TTL: "1s" }));
    // sign one minute in the past (TokenService reads Date.now; jose verifies with the real clock)
    const realNow = Date.now;
    Date.now = () => realNow() - 60_000;
    let token: string;
    try {
      ({ token } = await shortLived.signAccessToken(claims));
    } finally {
      Date.now = realNow;
    }
    await assert.rejects(shortLived.verifyAccessToken(token), TokenExpiredError);
  });

  it("rejects an HS256 token signed with the public key (algorithm confusion)", async () => {
    const jwk = tokens.jwks().keys[0]!;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ ...claims, typ: "access", iss: "https://api.eazotel.com", aud: "eazotel-app", exp: 9999999999 }),
    ).toString("base64url");
    const sig = createHmac("sha256", String(jwk.n)).update(`${header}.${body}`).digest("base64url");
    await assert.rejects(tokens.verifyAccessToken(`${header}.${body}.${sig}`), InvalidTokenError);
  });

  it("publishes only the public part of the key", () => {
    const [key] = tokens.jwks().keys;
    assert.deepEqual(Object.keys(key!).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
  });
});

describe("LegacyTokenService (nexon HS256 tokens)", () => {
  const legacy = new LegacyTokenService(testAuthConfig());

  it("signs exactly what nexon's utils.create produces: { Email, exp } with HS256", async () => {
    const token = await legacy.sign("owner@hotel.test");
    assert.deepEqual(decodeProtectedHeader(token), { alg: "HS256", typ: "JWT" });
    const payload = decodeJwt(token);
    assert.deepEqual(Object.keys(payload).sort(), ["Email", "exp"]);
    assert.ok(Math.abs(Number(payload.exp) - (Date.now() / 1000 + 15 * 86_400)) < 5);
    assert.deepEqual(await legacy.verify(token), { email: "owner@hotel.test" });
  });

  it("accepts a token nexon itself made (float exp, like Python's timestamp())", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ Email: "old@hotel.test", exp: Date.now() / 1000 + 3600.123456 }),
    ).toString("base64url");
    const sig = createHmac("sha256", LEGACY_SECRET).update(`${header}.${body}`).digest("base64url");
    assert.deepEqual(await legacy.verify(`${header}.${body}.${sig}`), { email: "old@hotel.test" });
  });

  it("rejects guest ({ Number }) and admin ({ emailId }) tokens", async () => {
    for (const payload of [{ Number: "9999999999" }, { emailId: "admin@eazotel.com" }]) {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() / 1000 + 3600 })).toString("base64url");
      const sig = createHmac("sha256", LEGACY_SECRET).update(`${header}.${body}`).digest("base64url");
      await assert.rejects(legacy.verify(`${header}.${body}.${sig}`), InvalidTokenError);
    }
  });

  it("rejects a token signed with another secret", async () => {
    const other = new LegacyTokenService(testAuthConfig({ AUTH_LEGACY_JWT_SECRET: "x".repeat(40) }));
    await assert.rejects(legacy.verify(await other.sign("owner@hotel.test")), InvalidTokenError);
  });
});
