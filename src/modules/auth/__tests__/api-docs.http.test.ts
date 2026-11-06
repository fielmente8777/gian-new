import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { readJson, startApp } from "./test-app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Spec = any;

describe("API docs (/docs, generated from the routes)", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let spec: Spec;

  before(async () => {
    app = await startApp();
    spec = await readJson(fetch(`${app.base}/docs/openapi.json`));
  });
  after(() => app.close());

  it("lists every auth route, new and legacy, with full paths", () => {
    assert.equal(spec.openapi, "3.1.0");
    const routes = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${path}`),
    );
    for (const route of [
      "POST /api/v1/auth/login",
      "POST /api/v1/auth/register",
      "POST /api/v1/auth/google",
      "POST /api/v1/auth/refresh",
      "POST /api/v1/auth/logout",
      "GET /api/v1/auth/me",
      "POST /api/v1/auth/password",
      "POST /api/v1/auth/legacy/exchange",
      "GET /.well-known/jwks.json",
      "POST /eazotel/ceateuser",
      "POST /user/googleauth",
      "POST /eazotel/edit/password",
      "POST /admin/switch-account",
    ]) {
      assert.ok(routes.includes(route), `${route} missing from docs`);
    }
  });

  it("request schema comes from the DTO that validates the route", () => {
    const login = spec.paths["/api/v1/auth/login"].post;
    const body = login.requestBody.content["application/json"].schema;
    assert.deepEqual(body.required.sort(), ["email", "password"]);
    assert.equal(body.properties.email.format, "email");
    assert.ok(login.parameters.some((p: Spec) => p.name === "X-Client-Platform" && p.in === "header"));
    assert.deepEqual(login.security, [], "login is public");
    assert.ok(login.responses["429"], "rate limit documented from the middleware");
    assert.ok(login.responses["400"], "validation error documented because the route has a body DTO");
  });

  it("auth comes from the middleware: protected routes need the bearer token", () => {
    assert.deepEqual(spec.paths["/api/v1/auth/me"].get.security, [{ bearerAuth: [] }]);
    assert.ok(spec.paths["/api/v1/auth/me"].get.responses["401"]);
    assert.deepEqual(spec.paths["/api/v1/auth/refresh"].post.security, [{ refreshCookie: [] }]);
  });

  it("responses: envelope for /api/v1, raw bodies for legacy and JWKS", () => {
    const ok = spec.paths["/api/v1/auth/me"].get.responses["200"].content["application/json"].schema;
    assert.deepEqual(ok.required, ["success", "data"]);
    assert.ok(ok.properties.data.properties.isStaff);
    assert.equal(
      spec.paths["/api/v1/auth/me"].get.responses["401"].content["application/json"].schema.$ref,
      "#/components/schemas/Error",
    );

    const legacy = spec.paths["/eazotel/ceateuser"].post;
    assert.equal(legacy.deprecated, true);
    assert.ok(legacy.responses["200"].content["application/json"].schema.properties.Status);
    assert.deepEqual(
      spec.paths["/.well-known/jwks.json"].get.responses["200"].content["application/json"].schema.required,
      ["keys"],
    );
  });

  it("legacy routes are documented but keep nexon's own validation", async () => {
    const res = await app.post("/eazotel/ceateuser", {});
    assert.deepEqual(await readJson(res), { Status: false });
  });

  it("serves Swagger UI and its assets", async () => {
    const page = await fetch(`${app.base}/docs/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("Eazotel API"));
    for (const asset of ["swagger-ui-bundle.js", "swagger-ui-init.js", "swagger-ui.css"]) {
      assert.equal((await fetch(`${app.base}/docs/${asset}`)).status, 200, asset);
    }
  });
});
