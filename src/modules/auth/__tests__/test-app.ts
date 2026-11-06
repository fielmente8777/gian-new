import type { AddressInfo } from "node:net";

import { pino } from "pino";

import { App } from "../../../app.js";
import { EventBus } from "../../../shared/events/event-bus.js";
import { AuthModule } from "../auth.module.js";
import { LegacyTokenService } from "../services/legacy-token.service.js";
import { FakeGoogle, InMemoryCredentials, InMemoryRefreshTokens, InMemoryUsers, testConfig } from "./fakes.js";

/** The real App + AuthModule over HTTP, with in-memory stores instead of MongoDB. */
export async function startApp(env: Record<string, string> = {}) {
  const config = testConfig(env);
  const logger = pino({ level: "silent" });
  const users = new InMemoryUsers();
  const refreshTokens = new InMemoryRefreshTokens();
  const events = new EventBus(logger);
  const auth = new AuthModule({
    config: config.auth,
    logger,
    events,
    users,
    overrides: { credentials: new InMemoryCredentials(), refreshTokens, google: new FakeGoogle() },
  });
  const server = new App({ config: config.app, logger, modules: [auth] }).express.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, token: string) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  return {
    base,
    post,
    get,
    users,
    refreshTokens,
    events,
    legacy: new LegacyTokenService(config.auth),
    clientAccountTokens: auth.clientAccountTokens,
    close: () => server.close(),
  };
}

// fetch types json() as unknown; these tests inspect arbitrary response bodies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readJson = async (res: Response | Promise<Response>): Promise<any> => (await res).json();
export const cookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("ez_rt="));
export const cookieValue = (setCookie: string | undefined) => setCookie?.split(";")[0] ?? "";
