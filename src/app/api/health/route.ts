import { NextResponse } from "next/server";
import { DEFAULT_RULES } from "@/lib/default-rules";
import { ensureSchema, listLlmProfileViews } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  try {
    await ensureSchema();
    const profiles = await listLlmProfileViews();
    return NextResponse.json({
      ok: true,
      service: "universal-order-importer",
      storage: process.env.DATABASE_URL ? "database" : "local-json",
      llmConfigured: profiles.some((profile) => profile.enabled !== false && profile.hasApiKey),
      defaultRuleCount: DEFAULT_RULES.length,
      gitCommit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        service: "universal-order-importer",
        error: error instanceof Error ? error.message : "Health check failed",
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}
