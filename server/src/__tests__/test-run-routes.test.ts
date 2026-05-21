import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTestRunService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockTestPlanService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/test-runs.js", () => ({
  testRunService: () => mockTestRunService,
}));

vi.mock("../services/test-plans.js", () => ({
  testPlanService: () => mockTestPlanService,
}));

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
    const [{ errorHandler }, { testRunRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/test-runs.js") as Promise<{ testRunRoutes: (db: any) => express.Router }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", testRunRoutes({} as any));
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

const sampleRun = {
  id: "run-1",
  companyId: "company-1",
  testPlanId: "plan-1",
  triggerType: "manual",
  status: "queued",
  resultSignal: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date(),
};

const samplePlan = {
  id: "plan-1",
  companyId: "company-1",
  name: "Checkout Load Test",
  engines: ["k6"],
  filePatterns: [],
  createdAt: new Date(),
};

describe.sequential("POST /api/companies/:companyId/test-runs", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestRunService)) mock.mockReset();
    for (const mock of Object.values(mockTestPlanService)) mock.mockReset();
  });

  it("creates TestRun with trigger_type=manual and returns 201", async () => {
    mockTestPlanService.getById.mockResolvedValue(samplePlan);
    mockTestRunService.create.mockResolvedValue(sampleRun);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-runs")
        .send({ testPlanId: "plan-1" }),
    );

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("run-1");
    expect(mockTestRunService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ testPlanId: "plan-1", triggerType: "manual" }),
    );
  });

  it("returns 422 when test_plan_id does not exist", async () => {
    mockTestPlanService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-runs")
        .send({ testPlanId: "nonexistent" }),
    );

    expect(res.status).toBe(422);
    expect(mockTestRunService.create).not.toHaveBeenCalled();
  });

  it("enforces company scope — plan from another company returns 422", async () => {
    mockTestPlanService.getById.mockResolvedValue({ ...samplePlan, companyId: "company-2" });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-runs")
        .send({ testPlanId: "plan-1" }),
    );

    expect(res.status).toBe(422);
    expect(mockTestRunService.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-runs")
        .send({ testPlanId: "plan-1" }),
    );

    expect(res.status).toBe(401);
  });
});

describe.sequential("GET /api/test-runs/:id", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestRunService)) mock.mockReset();
    for (const mock of Object.values(mockTestPlanService)) mock.mockReset();
  });

  it("returns TestRun with status and metrics", async () => {
    mockTestRunService.getById.mockResolvedValue(sampleRun);

    const app = await createApp();
    const res = await req(app, (base) => request(base).get("/api/test-runs/run-1"));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("run-1");
    expect(res.body.status).toBe("queued");
  });

  it("returns 404 for unknown id", async () => {
    mockTestRunService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await req(app, (base) => request(base).get("/api/test-runs/missing"));

    expect(res.status).toBe(404);
  });

  it("enforces company scope", async () => {
    mockTestRunService.getById.mockResolvedValue({ ...sampleRun, companyId: "company-2" });

    const app = await createApp();
    const res = await req(app, (base) => request(base).get("/api/test-runs/run-1"));

    expect(res.status).toBe(403);
  });
});

describe.sequential("GET /api/companies/:companyId/test-runs", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestRunService)) mock.mockReset();
    for (const mock of Object.values(mockTestPlanService)) mock.mockReset();
  });

  it("returns list of runs for a company", async () => {
    mockTestRunService.list.mockResolvedValue([sampleRun]);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/test-runs"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("run-1");
  });

  it("filters by test_plan_id when provided", async () => {
    mockTestRunService.list.mockResolvedValue([sampleRun]);

    const app = await createApp();
    await req(app, (base) =>
      request(base).get("/api/companies/company-1/test-runs?testPlanId=plan-1"),
    );

    expect(mockTestRunService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ testPlanId: "plan-1" }),
    );
  });
});
