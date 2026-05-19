import { detectHardware } from "@/lib/hardware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const profile = await detectHardware();
    return Response.json(profile);
  } catch (e) {
    return Response.json(
      {
        error: "hardware detection failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
