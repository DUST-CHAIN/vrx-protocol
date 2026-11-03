/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output: bundles a minimal server + only the node_modules actually used into
  // .next/standalone, so the Docker image stays small (disk on the Coolify box is tight). NOTE:
  // standalone does NOT copy `public/` or `.next/static` — the Dockerfile copies those explicitly.
  output: "standalone",

  //  whitepaper-link fix. public/whitepapers/ is a static directory whose only entry is index.html.
  // With trailingSlash:false (Next's default) a link to "/whitepapers/" 308-redirects to "/whitepapers",
  // which matches no route/file -> 404 (the links worked on the plain-static vettedrealty.com host but
  // dead-ended here). The app links now point at the index file directly; this redirect ALSO catches a
  // hand-typed bare "/whitepapers" so both forms resolve. Scoped to this one path on purpose — we do NOT
  // flip the global trailingSlash (that would ripple across every route and asset).
  async redirects() {
    return [
      { source: "/whitepapers", destination: "/whitepapers/index.html", permanent: true },
    ];
  },

  //  photo subsystem: `sharp` ships a NATIVE.node binary. Standalone output-tracing can miss a native
  // module that's only reached dynamically, so the box's `.next/standalone` would start without sharp and the
  // image pipeline would 500 at runtime. Force-include sharp's whole package into the trace for the two routes
  // that use it so the binary is always copied. (The box is node:22-alpine/musl — sharp's linuxmusl binary must
  // also install at `npm ci`; libc6-compat is present. Both are the deploy-risk checks.)
  outputFileTracingIncludes: {
    "/api/images/**": ["./node_modules/sharp/**", "./node_modules/@img/**"],
  },

  //  BUILD FIX. instrumentation.ts is compiled for BOTH the edge and node runtimes. Our indexer
  //  made register reach lib/catalog → status-cache → rpc-usage, which import Node builtins
  // (`fs`/`path`/`crypto`). Even behind a `NEXT_RUNTIME === 'nodejs'` guard + a dynamic import into a
  // separate instrumentation.node.ts, webpack 15.1 still TRACES that graph for the EDGE bundle and fails
  // with "Module not found: Can't resolve 'fs'". The runtime guard already guarantees this code never
  // EXECUTES on edge — so for the edge/client layers we resolve the Node builtins to empty. This only
  // affects bundles that legitimately cannot have these modules; the Node server bundle is untouched and
  // keeps the real `fs`/`path`/`crypto`. (Fixes the production build that would otherwise break the box
  // redeploy. Verified with `next build`.)
  webpack: (config, { isServer, nextRuntime }) => {
    // Apply to the client bundle AND the edge runtime (both lack Node builtins). The default Node server
    // build (isServer && nextRuntime === 'nodejs') is left alone.
    if (!isServer || nextRuntime === "edge") {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default nextConfig;
