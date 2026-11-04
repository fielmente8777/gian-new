// Fields our middlewares add to every Express request. Modules add their own the same
// way (auth adds `req.auth` in modules/auth/types/auth.types.ts).

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by RequestIdMiddleware; also sent back as the X-Request-Id header. */
      requestId: string;
      /** Parsed query / params from Validate.query / Validate.params (req.query is read-only in Express 5). */
      validated?: { query?: unknown; params?: unknown };
    }
  }
}

export {};
