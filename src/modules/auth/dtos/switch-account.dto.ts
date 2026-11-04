import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { emailField } from "./fields.js";

/** Staff: open a client account by its owner's email or by its tenant id (ndid). */
export class SwitchAccountDto extends BaseDto {
  static override readonly schema = z.union(
    [z.object({ email: emailField }).strict(), z.object({ ndid: z.string().trim().min(1).max(100) }).strict()],
    { error: "Send either email or ndid" },
  );
}
export type SwitchAccountBody = z.infer<typeof SwitchAccountDto.schema>;
