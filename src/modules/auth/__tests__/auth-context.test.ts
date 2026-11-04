import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AccountNotReadyError } from "../errors/auth.errors.js";
import { AuthContext } from "../types/auth-context.js";
import { InMemoryUsers } from "./fakes.js";

describe("AuthContext.can (permissions)", () => {
  const users = new InMemoryUsers();

  it("owner: account permissions on any property", () => {
    const owner = AuthContext.fromUser(users.add({ email: "o@h.test", isAdmin: true, scopes: ["cms"] }), "access", "s");
    assert.equal(owner.can("cms"), true);
    assert.equal(owner.can("cms", "any-hid"), true);
    assert.equal(owner.can("bookingEngine", "any-hid"), false);
  });

  it("team member: only the properties they are assigned to, with that property's permissions", () => {
    const member = AuthContext.fromUser(
      users.add({
        email: "m@h.test",
        isAdmin: false,
        role: "manager",
        scopes: [],
        locations: [{ hid: "111", scopes: ["frontDesk"] }],
      }),
      "access",
      "s",
    );
    assert.equal(member.can("frontDesk", "111"), true);
    assert.equal(member.can("frontDesk", "222"), false);
    assert.equal(member.can("cms", "111"), false);
  });

  it("refuses a user without ndid (no tenant to put in the token)", () => {
    assert.throws(
      () => AuthContext.fromUser(users.add({ email: "x@h.test", ndid: null }), "access", null),
      AccountNotReadyError,
    );
  });
});
