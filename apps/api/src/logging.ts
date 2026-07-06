// Logger configuration. HARD RULE (CLAUDE.md): no PII in application logs —
// no SSNs, EINs, DOBs, document contents, or request bodies. We therefore:
//   - never log request/response bodies anywhere in the app,
//   - strip query strings from logged URLs (tokens travel there),
//   - redact Authorization/Cookie headers,
//   - sanitize database errors before logging (pg error detail can echo
//     column values — see the error handler in server.ts).

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    censor: '[redacted]',
  },
  serializers: {
    req(req: { method: string; url: string; id: string }) {
      const q = req.url.indexOf('?');
      return {
        method: req.method,
        // path only — query strings can carry magic-link/reset tokens
        url: q === -1 ? req.url : req.url.slice(0, q),
        id: req.id,
      };
    },
    res(res: { statusCode: number }) {
      return { statusCode: res.statusCode };
    },
  },
};
