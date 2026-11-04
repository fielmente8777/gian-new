import type { Request } from "express";

/**
 * Reads one cookie from the request. Express can set cookies (`res.cookie`) but does not
 * parse them, and we only ever need a few by name, so this replaces cookie-parser.
 */
export class Cookies {
  static get(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return undefined;
  }
}
