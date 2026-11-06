import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { CredentialService } from "../services/credential.service.js";
import { LegacyPasswordHash } from "../services/legacy-password-hash.js";
import { PasswordService } from "../services/password.service.js";
import { InMemoryCredentials, InMemoryUsers } from "./fakes.js";

describe("CredentialService (password checks while nexon and gian-new both run)", () => {
  let users: InMemoryUsers;
  let credentials: InMemoryCredentials;
  let service: CredentialService;
  const passwords = new PasswordService(10);

  beforeEach(() => {
    users = new InMemoryUsers();
    credentials = new InMemoryCredentials();
    service = new CredentialService(credentials, users, passwords, true);
  });

  it("accepts a nexon password and upgrades it to bcrypt on first login", async () => {
    const user = users.add({ email: "a@hotel.test" }, LegacyPasswordHash.of("secret-1"));
    assert.equal(await service.verify(user.id, "secret-1"), true);
    const row = credentials.rows.get(user.id);
    assert.ok(row?.passwordHash.startsWith("$2"), "bcrypt hash stored");
    assert.equal(row?.legacyHash, LegacyPasswordHash.of("secret-1"));
    assert.equal(await service.verify(user.id, "secret-1"), true, "second login uses bcrypt");
  });

  it("rejects a wrong password and stores nothing", async () => {
    const user = users.add({ email: "a@hotel.test" }, LegacyPasswordHash.of("secret-1"));
    assert.equal(await service.verify(user.id, "wrong"), false);
    assert.equal(credentials.rows.size, 0);
  });

  it("follows a password changed in nexon after the upgrade", async () => {
    const user = users.add({ email: "a@hotel.test" }, LegacyPasswordHash.of("old-pass"));
    await service.verify(user.id, "old-pass");
    users.legacyHashes.set(user.id, LegacyPasswordHash.of("new-pass")); // nexon /eazotel/edit/password
    assert.equal(await service.verify(user.id, "old-pass"), false, "old bcrypt hash no longer wins");
    assert.equal(await service.verify(user.id, "new-pass"), true);
  });

  it('accepts the Google sign-up default password "Eazotel@123", until the hotel changes it', async () => {
    const user = users.add({ email: "g@hotel.test" }, LegacyPasswordHash.googleDefault);
    assert.equal(await service.verify(user.id, "wrong"), false);
    assert.equal(await service.verify(user.id, "Eazotel@123"), true);
    await service.setPassword(user.id, "hotels-own-password");
    assert.equal(await service.verify(user.id, "Eazotel@123"), false);
    assert.equal(await service.verify(user.id, "hotels-own-password"), true);
  });

  it("setPassword keeps nexon in sync while AUTH_LEGACY_PASSWORD_SYNC is on", async () => {
    const user = users.add({ email: "a@hotel.test" }, LegacyPasswordHash.of("old-pass"));
    await service.setPassword(user.id, "brand-new-pass");
    assert.equal(users.legacyHashes.get(user.id), LegacyPasswordHash.of("brand-new-pass"));
    assert.equal(await service.verify(user.id, "brand-new-pass"), true);
    assert.equal(await service.verify(user.id, "old-pass"), false);
  });

  it("with sync off, nexon's hash becomes unusable but gian-new logins work", async () => {
    const noSync = new CredentialService(credentials, users, passwords, false);
    const user = users.add({ email: "a@hotel.test" }, LegacyPasswordHash.of("old-pass"));
    await noSync.setPassword(user.id, "brand-new-pass");
    assert.equal(LegacyPasswordHash.isUsable(users.legacyHashes.get(user.id) ?? null), false);
    assert.equal(await noSync.verify(user.id, "brand-new-pass"), true);
  });
});
