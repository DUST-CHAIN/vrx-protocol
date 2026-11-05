// PUBLIC-REPO STUB. The image upload/serve routes carry the forensic tracing
// mechanism, which is deliberately not published (see the README). This stub stands in so the
// route path exists and reads as intentional rather than missing. The live product serves real,
// provenance-stamped images; the account-image INDEX + consent routes (/api/account-images) are
// published in full.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { error: "The image service is part of VRX's private mechanism and is not included in the public showcase repo." },
    { status: 410 },
  );
}

export async function POST() {
  return NextResponse.json(
    { error: "The image service is part of VRX's private mechanism and is not included in the public showcase repo." },
    { status: 410 },
  );
}
