import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { currentPasswordField, newPasswordField } from "./fields.js";

export class ChangePasswordDto extends BaseDto {
  static override readonly schema = z
    .object({
      currentPassword: currentPasswordField,
      newPassword: newPasswordField,
    })
    .refine((body) => body.currentPassword !== body.newPassword, {
      message: "New password must be different from the current one",
      path: ["newPassword"],
    });
}
export type ChangePasswordBody = z.infer<typeof ChangePasswordDto.schema>;
