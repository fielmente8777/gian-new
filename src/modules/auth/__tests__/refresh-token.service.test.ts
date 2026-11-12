import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { InvalidRefreshTokenError, RefreshInProgressError, RefreshTokenReuseError } from "../errors/auth.errors.js";
import { RefreshTokenService } from "../services/refresh-token.service.js";
import { InMemoryRefreshTokens } from "./fakes.js";

describe("RefreshTokenService (rotation + reuse detection)", () => {
  let store: InMemoryRefreshTokens;
  let service: RefreshTokenService;

  beforeEach(() => {
    store = new InMemoryRefreshTokens();
    service = new RefreshTokenService(store, 30, "eazotel-dashboard");
  });

  it("stores only a hash, never the token", async () => {
    const { token } = await service.issue("user-1", "family-1", {});
    assert.equal(store.rows.has(token), false);
    assert.equal(store.rows.has(RefreshTokenService.hash(token)), true);
  });

  it("rotates: the new token works, the old one is spent", async () => {
    const first = await service.issue("user-1", "family-1", {});
    const rotated = await service.rotate(first.token, {});
    assert.equal(rotated.userId, "user-1");
    assert.equal(rotated.familyId, "family-1");
    assert.notEqual(rotated.refreshToken.token, first.token);
    await service.rotate(rotated.refreshToken.token, {});
  });

  it("a lost response (page reloaded mid-refresh, or two tabs) continues the login", async () => {
    const first = await service.issue("user-1", "family-1", {});
    const lost = await service.rotate(first.token, {}); // the browser never stored this one
    const recovered = await service.rotate(first.token, {});
    assert.equal(recovered.familyId, "family-1");
    await service.rotate(recovered.refreshToken.token, {}); // and the login goes on
    // the retired replacement is now an old token whose successor was used
    await assert.rejects(service.rotate(lost.refreshToken.token, {}), RefreshInProgressError);
    store.age(RefreshTokenService.hash(lost.refreshToken.token), 60_000);
    await assert.rejects(service.rotate(lost.refreshToken.token, {}), RefreshTokenReuseError);
  });

  it("recovers a lost response even days later, while its replacement is still unused", async () => {
    const first = await service.issue("user-1", "family-1", {});
    await service.rotate(first.token, {});
    store.age(RefreshTokenService.hash(first.token), 3 * 86_400_000);
    const recovered = await service.rotate(first.token, {});
    await service.rotate(recovered.refreshToken.token, {});
  });

  it("two refreshes racing for the same replacement: one wins, the other is told to retry", async () => {
    const first = await service.issue("user-1", "family-1", {});
    const second = await service.rotate(first.token, {});
    await service.rotate(second.refreshToken.token, {}); // the replacement was used just now
    await assert.rejects(service.rotate(first.token, {}), RefreshInProgressError);
  });

  it("an old token whose replacement was used later revokes the whole family", async () => {
    const first = await service.issue("user-1", "family-1", {});
    const second = await service.rotate(first.token, {});
    const third = await service.rotate(second.refreshToken.token, {});
    store.age(RefreshTokenService.hash(first.token), 60_000);
    await assert.rejects(service.rotate(first.token, {}), RefreshTokenReuseError);
    await assert.rejects(
      service.rotate(third.refreshToken.token, {}),
      InvalidRefreshTokenError,
      "the other holder's copy is dead too",
    );
  });

  it("rejects unknown, expired and other-audience tokens", async () => {
    await assert.rejects(service.rotate("not-a-token", {}), InvalidRefreshTokenError);

    const expired = new RefreshTokenService(
      store,
      30,
      "eazotel-dashboard",
      () => new Date(Date.now() + 31 * 86_400_000),
    );
    const { token } = await service.issue("user-1", "family-1", {});
    await assert.rejects(expired.rotate(token, {}), InvalidRefreshTokenError);

    const admin = new RefreshTokenService(store, 30, "eazotel-admin");
    await assert.rejects(admin.rotate(token, {}), InvalidRefreshTokenError);
  });

  it("logout revokes the family; other sessions survive", async () => {
    const a = await service.issue("user-1", "family-a", {});
    const b = await service.issue("user-1", "family-b", {});
    await service.revoke(a.token, "logout");
    await assert.rejects(service.rotate(a.token, {}), InvalidRefreshTokenError);
    await service.rotate(b.token, {});
  });
});
