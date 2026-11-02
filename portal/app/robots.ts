import type { MetadataRoute } from "next";

// indexed or listed in search. Compliant crawlers obey this; the middleware UA wall + noindex meta cover the
// rest. (A determined scraper with a spoofed UA still isn't stopped — accepted limit for a demo.)
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
