// Post-build: rewrite root-absolute asset refs (/_astro/…, /img/…, /contact.php) to
// RELATIVE (./_astro/…) in every built .html, so the site works BOTH when opened directly
// via file:/// (double-clicking dist/index.html) AND when served from the web root.
// Safe because the site is flat (pages at dist root). If you ever add nested routes, this
// would need per-depth prefixes — fine for the current single-page site.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".html")) rewrite(p);
  }
}

function rewrite(file) {
  let html = readFileSync(file, "utf8");
  // href="/..."  and  src="/..."  ->  "./..."   (but NOT protocol-relative //… or full URLs)
  const before = html;
  html = html
    .replace(/(href|src)="\/(?!\/)/g, '$1="./')
    .replace(/(href|src)='\/(?!\/)/g, "$1='./");
  if (html !== before) {
    writeFileSync(file, html, "utf8");
    console.log("relativized:", file.replace(DIST, ""));
  }
}

walk(DIST);
console.log("relativize: done");
