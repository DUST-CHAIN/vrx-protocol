// MM is a client-side app. `npm run dev` + the portal use the normal server config; a STATIC EXPORT (for hosting
// MM standalone at e.g. vettedrealty.com/mm) is turned on ONLY when MM_EXPORT=1 so dev is unaffected. In export
// mode we drop the one server API route (/api/ai-build) via env — the AI text generator then needs the user's own
// path; the authoring studio + image-gen (client-side, user key) + export all still work. basePath=/mm so assets
// resolve under the subpath. (.)
const isExport = process.env.MM_EXPORT === "1";
const base = process.env.MM_BASE_PATH || (isExport ? "/mm" : "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Expose the base path to the client so runtime-located public assets (e.g. the web-ifc WASM via
  // SetWasmPath) resolve under a subpath export (dev="" / export "/mm" or "/vrx/mm"). (IFC import.)
  env: { NEXT_PUBLIC_MM_BASE_PATH: base },
  ...(isExport
    ? {
        output: "export",
        images: { unoptimized: true },
        basePath: base || undefined,
        assetPrefix: base || undefined,
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
