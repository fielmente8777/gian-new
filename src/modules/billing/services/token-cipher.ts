import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets kept in the database (the Zoho refresh token). The stored text is
 * `v1.<iv>.<tag>.<ciphertext>`, base64url; anyone with only a database copy can't use it.
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("the key must be 32 bytes");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decrypt(stored: string): string {
    const [version, iv, tag, data] = stored.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("not an encrypted token");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}
