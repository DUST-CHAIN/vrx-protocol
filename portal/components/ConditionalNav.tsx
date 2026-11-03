"use client";

// ConditionalNav — renders the global <Nav> top bar EXCEPT on the dashboard-shell routes, which
// own their own topbar via DashboardShell. Without this, shell pages would show two stacked top bars.
// Non-shell routes (landing /, /apply, /onboarding, /applications, /provisioned, /network) keep the
// plain <Nav>. Keep SHELL_ROUTES in sync with the pages that wrap themselves in DashboardShell.

import { usePathname } from "next/navigation";
import Nav from "@/components/Nav";

// Routes that own their OWN header (or are full-screen tools) → suppress the global <Nav> so it doesn't
// steal vertical space. The /admin image tools + tracer are full-bleed and have their own slim toolbar.
// /control (Proof of Flows) owns its own Proof-of-Flows banner and is a presenter screen — the
// generic VRX/role-picker/Connect-wallet bar is pure wasted vertical space there, so suppress it too.
const SHELL_ROUTES = ["/root", "/node", "/agency", "/agent", "/warroom", "/admin", "/control"];

export default function ConditionalNav() {
  const pathname = usePathname();
  const onShell = SHELL_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  if (onShell) return null;
  return <Nav />;
}
