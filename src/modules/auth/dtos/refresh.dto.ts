import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

/** /auth/refresh and /auth/logout. Browsers send nothing (cookie); the mobile app sends the token. */
export class RefreshDto extends BaseDto {
  static override readonly schema = z.object({
    refreshToken: z.string().min(20).max(200).optional(),
  });
}
export type RefreshBody = z.infer<typeof RefreshDto.schema>;
