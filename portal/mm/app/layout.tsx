import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MM — Marketing Materials authoring",
  description:
    "Assemble a valid VRX ingest-pack: buildings, units, texts, media → preview → export.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
