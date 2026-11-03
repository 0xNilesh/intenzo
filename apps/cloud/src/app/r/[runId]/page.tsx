// GET /r/[runId] (§12, §26): one run's report, with each criterion's videos. Private videos play
// through signed URLs valid for an hour (§28). The run's id is the only key for now (v0): the
// page is as private as the PR comment that links it.
import { statusLine } from "@intenzo/core";
import { notFound } from "next/navigation";

import { artifactUrls } from "../../../artifacts/read-urls.ts";
import { cloud, reportBaseUrl } from "../../../cloud.ts";
import { blobStores } from "../../../env.ts";
import { reportPage } from "../../../report/page-data.ts";

export const dynamic = "force-dynamic";

const ICON = { pass: "✅", fail: "❌", inconclusive: "⚠️" } as const;
const seconds = (ms: number) => Math.max(0, ms / 1000).toFixed(1);

export default async function Report({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { env, db } = cloud();
  const data = await reportPage(db, runId, artifactUrls(blobStores(env)), reportBaseUrl(env));
  if (!data) notFound();
  const { model, videos } = data;
  const { run } = model;

  return (
    <main style={{ maxWidth: 960, margin: "3rem" }}>
      <h1 style={{ fontSize: "1.4rem" }}>
        Intenzo · {statusLine(model)} · attempt {run.attemptNo}
      </h1>
      <p>
        Commit <code>{run.headSha.slice(0, 7)}</code>
        {run.baseline && (
          <>
            {" "}
            against <code>{run.baseline.sha.slice(0, 7)}</code>
            {run.baseline.drift === 0
              ? " (the merge base)"
              : ` (${run.baseline.drift} commits before the merge base)`}
          </>
        )}
        {run.judges.length > 0 && <> · judges: {run.judges.join(" + ")}</>}
      </p>
      {model.criteria.length === 0 && <p>No criteria judged yet.</p>}
      {model.criteria.map((c) => {
        const clip = c.clip ? `#t=${seconds(c.clip.startMs)},${seconds(c.clip.endMs)}` : "";
        const sides = videos[c.id] ?? {};
        return (
          <section key={c.id} id={c.id} style={{ borderTop: "1px solid #ccc", paddingTop: "1rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>
              {c.verdict ? ICON[c.verdict] : "⏳"} {c.id} {c.text}
            </h2>
            <p>Expected: {c.expected}</p>
            {c.observed && <p>Observed: {c.observed}</p>}
            {c.readings && <p>Readings: {c.readings}</p>}
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {sides.pr && (
                <figure style={{ margin: 0 }}>
                  <figcaption>This PR</figcaption>
                  <video controls preload="metadata" width={440} src={`${sides.pr}${clip}`} />
                </figure>
              )}
              {sides.base && (
                <figure style={{ margin: 0 }}>
                  <figcaption>Before (the baseline)</figcaption>
                  <video controls preload="metadata" width={440} src={sides.base} />
                </figure>
              )}
            </div>
          </section>
        );
      })}
    </main>
  );
}
