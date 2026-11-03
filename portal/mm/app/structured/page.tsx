"use client";

// /structured — now just renders the shared one-frame app (app/AppShell.tsx). Kept as a stable deep-link
// to the app; the canonical home is `/`. The shell used to live HERE (and the top nav called this route
// "Structured", colliding with the in-frame "Structured" FACE — the exact confusion the simplification pass,
// D- removed). The face switch inside the frame is the only navigation now.

import { AppShell } from "../AppShell";

export default function StructuredPage() {
  return <AppShell />;
}
