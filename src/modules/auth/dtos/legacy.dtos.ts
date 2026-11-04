import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

// Bodies of the old nexon paths, as the dashboard and onboarding app send them today.
// Deliberately as loose as nexon (it validated nothing), so no existing client breaks.

/** POST /eazotel/ceateuser — login, or sign-up when register === "true" (the string, like nexon) */
export class LegacyCreateUserDto extends BaseDto {
  static override readonly schema = z.object({
    register: z.unknown().optional(),
    emailId: z.string().trim().min(1).max(254),
    accesskey: z.string().min(1).max(256),
    userName: z.string().trim().max(100).nullish(),
    hotelPhone: z.union([z.string(), z.number()]).nullish(),
  });
}
export type LegacyCreateUserBody = z.infer<typeof LegacyCreateUserDto.schema>;

/** POST /eazotel/edit/password — the token travels in the body */
export class LegacyEditPasswordDto extends BaseDto {
  static override readonly schema = z.object({
    token: z.string().min(1),
    oldAccessId: z.string().min(1).max(256),
    newAccessId: z.string().min(1).max(256),
  });
}
export type LegacyEditPasswordBody = z.infer<typeof LegacyEditPasswordDto.schema>;
