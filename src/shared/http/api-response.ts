import { z } from "zod";

// The two response envelopes of /api/v1 (README §6). Legacy nexon paths do not use
// them: they answer in the old shape through their module's legacy mapper.

export const errorDetailSchema = z.object({
  field: z.string().optional().meta({ example: "email" }),
  message: z.string().meta({ example: "Enter a valid email address" }),
});

export const errorBodySchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string().meta({ description: "stable, switch on this", example: "VALIDATION_FAILED" }),
      message: z.string().meta({ description: "human readable, may change", example: "Enter a valid email address" }),
      details: z.array(errorDetailSchema).optional(),
      requestId: z
        .string()
        .optional()
        .meta({ description: "also in the X-Request-Id header; quote it when reporting a bug" }),
    }),
  })
  .meta({ id: "Error", description: "Every /api/v1 error" });

export type ErrorBody = z.infer<typeof errorBodySchema>;

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}
