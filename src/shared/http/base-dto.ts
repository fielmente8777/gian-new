import type { z } from "zod";

import type { ErrorDetail } from "../errors/app-error.js";

/** Anything with a zod schema can be used as a DTO by the validate middleware. */
export interface DtoClass<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
}

export type DtoParseResult<T> = { success: true; data: T } | { success: false; details: ErrorDetail[] };

/**
 * Parent of every request DTO (Data Transfer Object): the shape a body, query or
 * params object must have. A DTO declares `static override readonly schema = z.object(...)`
 * and its TypeScript type is `z.infer<typeof XDto.schema>`.
 */
export abstract class BaseDto {
  declare static readonly schema: z.ZodType;

  static parse<S extends z.ZodType>(this: DtoClass<S>, input: unknown): DtoParseResult<z.output<S>> {
    const result = this.schema.safeParse(input ?? {});
    if (result.success) return { success: true, data: result.data };
    return {
      success: false,
      details: result.error.issues.map((issue) => ({
        field: issue.path.join(".") || undefined,
        message: issue.message,
      })),
    };
  }
}
