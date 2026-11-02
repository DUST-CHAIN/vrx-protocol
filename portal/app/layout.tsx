import type { Metadata } from "next";
import type { ReactNode } from "react";
import { inter } from "@/lib/fonts";
import { WalletProvider } from "@/lib/wallet";
import { RoleProvider } from "@/lib/role";
import { CurrencyProvider } from "@/lib/currency-provider";
import { PrefsProvider } from "@/lib/prefs";
import ConditionalNav from "@/components/ConditionalNav";
import DevAccountSwitcher from "@/components/DevAccountSwitcher";
import PasswordGate from "@/components/PasswordGate";
import AppShellGuards from "@/components/AppShellGuards";
import "./globals.css";

export const metadata: Metadata = {
  title: "VRX — a preview of Vetted Realty",
  description:
    "Constitutional freedom to globally transact. A private, secure reservation platform — a peek into the Vetted Realty world.",
  // never surface in search. Belt-and-suspenders with app/robots.ts (robots.txt) + the middleware UA wall.
  robots: { index: false, follow: false, nocache: true },
  // S159c PWA: iOS ignores the manifest's `display`, so opt it into standalone/fullscreen the Apple way.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "VRX" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  // S159c: match the PWA theme + paint behind the notch so the standalone/installed app reads fullscreen.
  themeColor: "#0a0e17",
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body
        style={{
          margin: 0,
          // Self-hosted Inter (lib/fonts) with the old system stack as the built-in fallback (F5, de-google).
          fontFamily: "var(--font-inter), system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#0a0e17",
          color: "#e8ecf4",
        }}
      >
        <PasswordGate>
          <AppShellGuards>
            <WalletProvider>
              <RoleProvider>
                <CurrencyProvider>
                  <PrefsProvider>
                    <ConditionalNav />
                    {children}
                    <DevAccountSwitcher />
                  </PrefsProvider>
                </CurrencyProvider>
              </RoleProvider>
            </WalletProvider>
          </AppShellGuards>
        </PasswordGate>
      </body>
    </html>
  );
}
