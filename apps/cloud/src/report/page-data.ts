// What the report page shows for one run: its report model, plus a playable URL for each
// criterion's videos, PR side and base side (§28: private videos through signed URLs).
import type { LaneResult, ReportModel } from "@intenzo/core";
import { eq } from "drizzle-orm";

import type { ArtifactUrl } from "../artifacts/read-urls.ts";
import type { Db } from "../db/db.ts";
import { criteriaResults, runs } from "../db/schema.ts";
import { reportModel } from "./model.ts";

export interface ReportPage {
  model: ReportModel;
  /** By criterion id: each side's human video, if it was recorded. */
  videos: Record<string, { pr?: string; base?: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function reportPage(
  db: Db,
  runId: string,
  url: ArtifactUrl,
  reportBaseUrl: string,
): Promise<ReportPage | null> {
  if (!UUID.test(runId)) return null;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;
  const model = await reportModel(db, run.runGroupId, reportBaseUrl, runId);
  if (!model) return null;

  const videos: ReportPage["videos"] = {};
  const results = await db.select().from(criteriaResults).where(eq(criteriaResults.runId, runId));
  for (const result of results) {
    for (const lane of (result.lanesJson ?? []) as LaneResult[]) {
      if (!lane.humanVideo) continue;
      const playable = await url(lane.humanVideo);
      if (playable) (videos[result.criterionId] ??= {})[lane.side] = playable;
    }
  }
  return { model, videos };
}
