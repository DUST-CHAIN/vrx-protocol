/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output: bundles a minimal server + only the node_modules actually used into
  //.next/standalone, so the Docker image stays small (disk on the Coolify box is tight). NOTE:
  // standalone does NOT copy `public/` or `.next/static` — the Dockerfile copies those explicitly.
  output: "standalone",
};

export default nextConfig;
