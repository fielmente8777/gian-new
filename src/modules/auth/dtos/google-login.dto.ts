import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

export class GoogleLoginDto extends BaseDto {
  static override readonly schema = z.object({
    /** the `credential` the Google sign-in button returns */
    idToken: z.string().min(20, "idToken is required").max(4096),
  });
}
export type GoogleLoginBody = z.infer<typeof GoogleLoginDto.schema>;
