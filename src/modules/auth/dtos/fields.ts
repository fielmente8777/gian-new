import { z } from "zod";

// Field rules shared by the auth DTOs.

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address" }).max(254))
  .meta({ format: "email", example: "owner@hotel.com" });

/** For checking an existing password: any length nexon may have stored. */
export const currentPasswordField = z
  .string()
  .min(1, "Password is required")
  .max(256)
  .meta({ format: "password", example: "my-secret-pass" });

/** For setting a password. bcrypt only reads the first 72 bytes, so longer ones are refused. */
export const newPasswordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 bytes")
  .meta({ format: "password", description: "8+ characters, at most 72 bytes", example: "a-long-new-pass" });
