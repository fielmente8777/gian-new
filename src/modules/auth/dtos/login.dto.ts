import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { currentPasswordField, emailField } from "./fields.js";

export class LoginDto extends BaseDto {
  static override readonly schema = z.object({
    email: emailField,
    password: currentPasswordField,
  });
}
export type LoginInput = z.infer<typeof LoginDto.schema>;
