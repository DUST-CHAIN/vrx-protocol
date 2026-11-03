import type { Metadata } from "next";
import "./globals.css";
import { ProjectProvider } from "./useProject";
import { WalletProvider } from "./useWallet";

export const metadata: Metadata = {
  title: "VRX · NEAR Model Maker",
  description:
    "Design a building, then have a NEAR developer account sign off on it — a sealed, identity-bearing VRX ingest-pack.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/*  (D-): the top route-nav is GONE — the frame's face switch [Structured|Studio|Preview] is the
            only navigation now. The old AI/grid/board screens are reached as the two FRONT DOORS on the `/` start
            screen (+ "✦ Start over" inside the frame), not as competing top-nav routes. */}
        <ProjectProvider>
          <WalletProvider>
            {children}
          </WalletProvider>
        </ProjectProvider>
      </body>
    </html>
  );
}
