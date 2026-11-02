"use client";

// ConditionalNav — renders the global <Nav> top bar EXCEPT on the dashboard-shell routes, which
// own their own topbar via DashboardShell. Without this, shell pages would show two stacked top bars.
// Non-shell routes (landing /, /apply, /onboarding, /applications, /provisioned, /network) keep the
// plain <Nav>. Keep SHELL_ROUTES in sync with the pages that wrap themselves in DashboardShell.

import { usePathname } from "next/navigation";
import Nav from "@/components/Nav";

const SHELL_ROUTES = ["/root", "/node", "/agency", "/agent", "/warroom"];

export default function ConditionalNav() {
  const pathname = usePathname();
  const onShell = SHELL_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  if (onShell) return null;
  return <Nav />;
}
