/// <reference lib="deno.ns" />

// Supabase Edge Function entry point
// Delegates all HTTP handling to the Hono app defined in src/server.ts
// NOTE: src/ is copied here at deploy time (see pnpm deploy:edge)

import { app } from "./src/server.ts";

Deno.serve((req: Request) => {
  // Supabase routes: /crypto-payments/... → strip the function-name prefix
  const url = new URL(req.url);
  const prefix = "/crypto-payments";
  if (url.pathname.startsWith(prefix)) {
    const newPath = url.pathname.slice(prefix.length) || "/";
    const rewritten = new URL(newPath + url.search, url.origin);
    return app.fetch(new Request(rewritten, req));
  }
  return app.fetch(req);
});
