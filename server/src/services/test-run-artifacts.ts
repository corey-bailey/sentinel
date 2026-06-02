// server/src/services/test-run-artifacts.ts
import fs from "node:fs/promises";
import path from "node:path";
import { testRunArtifacts, type Db } from "@sentinel/db";

export type CreateArtifactInput = {
  pipelineRunId: string;
  executionRunId?: string | null;
  testRunId?: string | null;
  artifactType: string; // k6_html_summary | sentinel_summary | stdout_log | ...
  storageRef: string;   // v1: on-disk cwd path (no external storage yet)
  url?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
};

export function testRunArtifactsService(db: Db) {
  async function create(companyId: string, data: CreateArtifactInput) {
    const [row] = await db
      .insert(testRunArtifacts)
      .values({
        companyId,
        pipelineRunId: data.pipelineRunId,
        executionRunId: data.executionRunId ?? null,
        testRunId: data.testRunId ?? null,
        artifactType: data.artifactType,
        storageRef: data.storageRef,
        url: data.url ?? null,
        contentType: data.contentType ?? null,
        sizeBytes: data.sizeBytes ?? null,
      })
      .returning();
    return row!;
  }

  // Records the k6 handleSummary HTML (summary-<testRunId2>.html in the run cwd) as a k6_html_summary
  // artifact. v1 storage = the on-disk path; returns null if the file is absent (e.g. a failed run).
  async function persistK6HtmlSummary(
    companyId: string,
    input: { pipelineRunId: string; executionRunId: string; testRunId: string | null; cwd: string; testRunId2: string },
  ) {
    const file = path.join(input.cwd, `summary-${input.testRunId2}.html`);
    let sizeBytes: number;
    try {
      sizeBytes = (await fs.stat(file)).size;
    } catch {
      return null;
    }
    return create(companyId, {
      pipelineRunId: input.pipelineRunId,
      executionRunId: input.executionRunId,
      testRunId: input.testRunId,
      artifactType: "k6_html_summary",
      storageRef: file,
      contentType: "text/html",
      sizeBytes,
    });
  }

  return { create, persistK6HtmlSummary };
}
