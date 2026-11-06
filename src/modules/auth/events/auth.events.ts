import type { ClientPlatform } from "../../../shared/http/request-client.js";
import type { LoginMethod } from "../types/auth.types.js";

// Events the auth module emits. The subscription module will listen to
// "user.registered" to start the free plan (what nexon does by calling gian /user/subscribe).
declare module "../../../shared/events/event-bus.js" {
  interface DomainEvents {
    "user.registered": { userId: string; ndid: string; email: string; method: LoginMethod };
    "user.logged_in": { userId: string; ndid: string; method: LoginMethod; ip?: string; platform?: ClientPlatform };
    "user.password_changed": { userId: string };
  }
}

export {};
