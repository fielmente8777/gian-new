import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { emailField, newPasswordField } from "./fields.js";

export class RegisterDto extends BaseDto {
  static override readonly schema = z.object({
    email: emailField,
    password: newPasswordField,
    name: z.string().trim().min(1, "Name is required").max(100),
    phone: z.string().trim().min(6).max(20).optional(),
  });
}
export type RegisterBody = z.infer<typeof RegisterDto.schema>;
