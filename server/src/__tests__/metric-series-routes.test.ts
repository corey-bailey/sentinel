import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMetricSeriesService = vi.hoisted(() => ({
  ingest: vi.fn(),
}));

vi.mock("../services/metric-series.js", () => ({
  metricSeriesService: () => mockMetricSeriesService,
}));

// Mirror server/src/__tests__/test-run-routes.test.ts's createApp(): the default actor is a
// board user with an ACTIVE admin membership for company-1 — required because assertCompanyAccess
// gates non-safe (POST) methods on an active, non-viewer membership, so the 403 case depends on
// passing an actor WITHOUT company access (companyIds excludes company-1).
function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
    memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
  },
) {
  return (async () => {
    const [{ errorHandler }, { metricSeriesRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/metric-series.js") as Promise<{
        metricSeriesRoutes: (db: any) => express.Router;
      }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", metricSeriesRoutes({} as any));
    app.use(errorHandler);
    return app;
  })();
}

async function req(app: express.Express, buildReq: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    return await buildReq(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe.sequential("POST /api/companies/:companyId/metric-series", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockMetricSeriesService)) mock.mockReset();
  });

  it("returns 201 and the created rows", async () => {
    mockMetricSeriesService.ingest.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/metric-series")
        .send({
          testRunId: "00000000-0000-0000-0000-000000000001",
          source: "k6",
          series: [{ metric: "p95_ms", phase: "steady", value: 180, sampleCount: 1000 }],
        }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(mockMetricSeriesService.ingest).toHaveBeenCalledOnce();
    expect(mockMetricSeriesService.ingest).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        testRunId: "00000000-0000-0000-0000-000000000001",
        source: "k6",
      }),
    );
  });

  it("returns 422 on an invalid body (missing series)", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/metric-series")
        .send({ testRunId: "00000000-0000-0000-0000-000000000001", source: "k6" }),
    );

    expect(res.status).toBe(422);
    expect(mockMetricSeriesService.ingest).not.toHaveBeenCalled();
  });

  it("returns 403 when the actor lacks company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["other"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "other", status: "active", membershipRole: "admin" }],
    });
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/metric-series")
        .send({
          testRunId: "00000000-0000-0000-0000-000000000001",
          source: "k6",
          series: [{ metric: "p95_ms", phase: "steady", value: 1, sampleCount: 1 }],
        }),
    );

    expect(res.status).toBe(403);
    expect(mockMetricSeriesService.ingest).not.toHaveBeenCalled();
  });
});
