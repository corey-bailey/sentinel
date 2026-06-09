// server/src/services/test-run-artifacts.ts
import fs from "node:fs/promises";
import path from "node:path";
import { testRunArtifacts, type Db } from "@sentinel/db";
import type { StorageService } from "../storage/types.js";

export type CreateArtifactInput = {
  pipelineRunId: string;
  executionRunId?: string | null;
  testRunId?: string | null;
  artifactType: string; // k6_html_summary | sentinel_summary | stdout_log | ...
  storageRef: string;   // storage objectKey; legacy rows hold an absolute on-disk path
  url?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
};

// Without a StorageService the artifact is recorded against its on-disk path (legacy/dev-only:
// the file dies with the temp workspace). With one, content is putFile'd to durable storage
// and storageRef is the returned objectKey — the /artifacts/:id/content route resolves both.
export function testRunArtifactsService(db: Db, storage?: StorageService) {
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

  async function persistBuffer(
    companyId: string,
    input: {
      pipelineRunId: string;
      executionRunId?: string | null;
      testRunId?: string | null;
      artifactType: string;
      filename: string;
      contentType: string;
      body: Buffer;
      fallbackPath: string;
    },
  ) {
    if (storage) {
      const put = await storage.putFile({
        companyId,
        namespace: `pipeline-runs/${input.pipelineRunId}`,
        originalFilename: input.filename,
        contentType: input.contentType,
        body: input.body,
      });
      return create(companyId, {
        pipelineRunId: input.pipelineRunId,
        executionRunId: input.executionRunId,
        testRunId: input.testRunId,
        artifactType: input.artifactType,
        storageRef: put.objectKey,
        contentType: put.contentType,
        sizeBytes: put.byteSize,
      });
    }
    return create(companyId, {
      pipelineRunId: input.pipelineRunId,
      executionRunId: input.executionRunId,
      testRunId: input.testRunId,
      artifactType: input.artifactType,
      storageRef: input.fallbackPath,
      contentType: input.contentType,
      sizeBytes: input.body.length,
    });
  }

  // Records the k6 handleSummary HTML (summary-<testRunId2>.html in the run cwd) as a
  // k6_html_summary artifact. Returns null if the file is absent (e.g. a failed run).
  async function persistK6HtmlSummary(
    companyId: string,
    input: { pipelineRunId: string; executionRunId: string; testRunId: string | null; cwd: string; testRunId2: string },
  ) {
    const file = path.join(input.cwd, `summary-${input.testRunId2}.html`);
    let body: Buffer;
    try {
      body = await fs.readFile(file);
    } catch {
      return null;
    }
    return persistBuffer(companyId, {
      pipelineRunId: input.pipelineRunId,
      executionRunId: input.executionRunId,
      testRunId: input.testRunId,
      artifactType: "k6_html_summary",
      filename: `summary-${input.testRunId2}.html`,
      contentType: "text/html",
      body,
      fallbackPath: file,
    });
  }

  return { create, persistBuffer, persistK6HtmlSummary };
}
