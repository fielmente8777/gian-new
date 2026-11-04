import type { Request } from "express";

/** Which app is calling. Browsers are "web"; the mobile apps send `X-Client-Platform: android | ios`. */
export type ClientPlatform = "web" | "android" | "ios";

export interface RequestClientInfo {
  platform: ClientPlatform;
  /** stable id of the phone (`X-Device-Id`), so a user can see and end the session of one device */
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}

const DEVICE_ID = /^[\w.:-]{1,128}$/;

/** Caller details worth storing with a session (IP behind TRUST_PROXY, shortened user agent). */
export class RequestClient {
  static of(req: Request): RequestClientInfo {
    const platform = req.get("x-client-platform")?.trim().toLowerCase();
    const deviceId = req.get("x-device-id")?.trim();
    return {
      platform: platform === "android" || platform === "ios" ? platform : "web",
      ...(deviceId && DEVICE_ID.test(deviceId) ? { deviceId } : {}),
      ip: req.ip,
      userAgent: req.get("user-agent")?.slice(0, 256),
    };
  }

  static isNative(platform: ClientPlatform): boolean {
    return platform !== "web";
  }
}
