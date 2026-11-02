import type { MetadataRoute } from "next";

// a service worker would cache assets, and a stale cache is exactly the blank-screen / old-chunk class of bug
// we already hit (S159b). The manifest alone gets us fullscreen + a saner mobile back-button (a standalone
// app doesn't navigate the whole page away on Back), with none of the offline-cache risk. Icon is app/icon.svg
// (crisp at any size; declared `any maskable` so Android masks it into its icon shape cleanly).
// Note: this is a PRIVATE PREVIEW — the layout still sets robots noindex/nofollow + the middleware bot wall.
// A manifest doesn't change that; it only helps a human who's been given the passphrase install the demo.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VRX — a preview of Vetted Realty",
    short_name: "VRX",
    description:
      "A private, secure reservation platform — a preview of the Vetted Realty world. Invite-only preview.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0a0e17",
    theme_color: "#0a0e17",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
