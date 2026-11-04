import type { RequestHandler } from "express";

import { ValidationError } from "../errors/http-errors.js";
import { BaseDto, type DtoClass } from "../http/base-dto.js";
import "../http/express-request.js";

/**
 * Checks one part of the request against a DTO before the controller runs.
 * The body is replaced with the parsed value (unknown keys stripped, defaults applied).
 * Query and params go to `req.validated`, because Express 5 makes req.query read-only.
 */
export class Validate {
  static body(dto: DtoClass): RequestHandler {
    return (req, _res, next) => {
      const result = BaseDto.parse.call(dto, req.body);
      if (!result.success) return next(new ValidationError(result.details));
      req.body = result.data;
      next();
    };
  }

  static query(dto: DtoClass): RequestHandler {
    return (req, _res, next) => {
      const result = BaseDto.parse.call(dto, req.query);
      if (!result.success) return next(new ValidationError(result.details));
      req.validated = { ...req.validated, query: result.data };
      next();
    };
  }

  static params(dto: DtoClass): RequestHandler {
    return (req, _res, next) => {
      const result = BaseDto.parse.call(dto, req.params);
      if (!result.success) return next(new ValidationError(result.details));
      req.validated = { ...req.validated, params: result.data };
      next();
    };
  }
}
