import type { Router } from "express";
import { z } from "zod";

import { errorBodySchema } from "../http/api-response.js";
import { RouteDocs, type OperationRecord } from "./route-doc.js";

type JsonSchema = Record<string, unknown>;

export interface ApiInfo {
  title: string;
  version: string;
  description: string;
  serverUrl: string;
  refreshCookieName: string;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No content",
  400: "Invalid request (VALIDATION_FAILED, INVALID_JSON)",
  401: "Not signed in, or the token is invalid / expired",
  403: "Signed in, but not allowed",
  404: "Not found",
  409: "Conflict",
  422: "Business rule failed",
  429: "Too many requests (RATE_LIMITED)",
  500: "Unexpected error (INTERNAL_ERROR)",
  503: "Service unavailable",
};

/**
 * Builds the OpenAPI 3.1 document from the routes the modules actually registered
 * (see BaseRoutes / RouteDocs). Nothing is written by hand: request schemas come from the
 * DTOs that validate the request, auth and rate-limit info from the middlewares used.
 */
export class OpenApiBuilder {
  private readonly paths: Record<string, Record<string, unknown>> = {};
  private readonly tags = new Set<string>();

  constructor(private readonly info: ApiInfo) {}

  /** Adds every documented route of `router`, which the app mounts at `basePath`. */
  add(router: Router | undefined, basePath = ""): this {
    if (!router) return this;
    for (const operation of RouteDocs.of(router)) this.addOperation(operation, basePath);
    return this;
  }

  build(): Record<string, unknown> {
    return {
      openapi: "3.1.0",
      info: { title: this.info.title, version: this.info.version, description: this.info.description },
      servers: [{ url: this.info.serverUrl }],
      tags: [...this.tags].sort(OpenApiBuilder.tagOrder).map((name) => ({ name })),
      paths: this.paths,
      components: {
        schemas: { Error: OpenApiBuilder.schema(errorBodySchema, "output") },
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "accessToken from /api/v1/auth/login, /google or /refresh. Old nexon tokens are accepted too.",
          },
          refreshCookie: { type: "apiKey", in: "cookie", name: this.info.refreshCookieName },
        },
      },
    };
  }

  private addOperation({ method, path, spec, middlewares }: OperationRecord, basePath: string): void {
    const openApiPath = `${basePath}${path}`.replace(/:(\w+)/g, "{$1}");
    const envelope = spec.envelope !== false;
    for (const tag of spec.tags ?? []) this.tags.add(tag);

    const bearer = middlewares.some((m) => m.bearer);
    const permission = middlewares.find((m) => m.permission)?.permission;
    const security = [...(bearer ? [{ bearerAuth: [] }] : []), ...(spec.refreshCookie ? [{ refreshCookie: [] }] : [])];

    const errors: Record<number, string | undefined> = { 500: undefined };
    if (spec.params || spec.query || spec.body) errors[400] = undefined;
    for (const m of middlewares) Object.assign(errors, m.errors);
    Object.assign(errors, spec.errors);

    const status = spec.response?.status ?? 200;
    const responses: Record<string, unknown> = {
      [status]: this.success(status, spec.response?.schema, spec.response?.description, envelope),
    };
    for (const [code, detail] of Object.entries(errors)) {
      const description = [STATUS_TEXT[Number(code)] ?? "Error", detail].filter(Boolean).join(" — ");
      responses[code] = envelope
        ? { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        : { description };
    }

    const description = [spec.description, permission && `Requires permission \`${permission}\`.`]
      .filter(Boolean)
      .join("\n\n");
    this.paths[openApiPath] ??= {};
    this.paths[openApiPath][method] = {
      tags: spec.tags,
      summary: spec.summary,
      ...(description ? { description } : {}),
      operationId: OpenApiBuilder.operationId(method, openApiPath),
      ...(spec.deprecated ? { deprecated: true } : {}),
      security,
      parameters: [
        ...this.parameters(spec.params, "path", openApiPath),
        ...this.parameters(spec.query, "query"),
        ...(spec.headers ?? []).map((h) => ({
          name: h.name,
          in: "header",
          required: h.required ?? false,
          description: h.description,
          schema: h.enum ? { type: "string", enum: h.enum } : { type: "string" },
        })),
      ],
      ...(spec.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: OpenApiBuilder.schema(spec.body.schema, "input") } },
            },
          }
        : {}),
      responses,
    };
  }

  private success(status: number, schema: z.ZodType | undefined, description: string | undefined, envelope: boolean) {
    const text = description ?? STATUS_TEXT[status] ?? "OK";
    if (status === 204 || !schema) return { description: text };
    const data = OpenApiBuilder.schema(schema, "output");
    const body = envelope
      ? { type: "object", required: ["success", "data"], properties: { success: { const: true }, data } }
      : data;
    return { description: text, content: { "application/json": { schema: body } } };
  }

  /** Query / path DTO → one OpenAPI parameter per property; undeclared path params become strings. */
  private parameters(dto: { schema: z.ZodType } | undefined, where: "path" | "query", path = "") {
    const schema = dto ? OpenApiBuilder.schema(dto.schema, "input") : { properties: {} };
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const params = Object.entries(properties).map(([name, property]) => ({
      name,
      in: where,
      required: where === "path" || required.has(name),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      schema: property,
    }));
    if (where === "path") {
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
        if (name && !properties[name]) params.push({ name, in: "path", required: true, schema: { type: "string" } });
      }
    }
    return params;
  }

  /** zod → JSON Schema 2020-12 (what OpenAPI 3.1 uses). Requests use input types, responses output types. */
  static schema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
    const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
      io,
      unrepresentable: "any",
      reused: "inline",
    }) as JsonSchema;
    return json;
  }

  private static operationId(method: string, path: string): string {
    const words = path.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    return method + words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  }

  /** New API tags first, then the rest; "Legacy …" tags last. */
  private static tagOrder(a: string, b: string): number {
    const rank = (tag: string) => (tag.startsWith("Legacy") ? 2 : tag === "System" ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
  }
}
