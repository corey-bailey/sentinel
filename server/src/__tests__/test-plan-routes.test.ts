import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTestPlanService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
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
    const [{ errorHandler }, { testPlanRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/test-plans.js") as Promise<{ testPlanRoutes: (db: any) => express.Router }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", testPlanRoutes({} as any));
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

const samplePlan = {
  id: "plan-1",
  companyId: "company-1",
  name: "Checkout load test",
  requirementId: null,
  engines: ["k6", "playwright"],
  loadProfile: { vus: 10, stages: [{ duration: "1m", target: 10 }] },
  apmProvider: null,
  apmServiceId: null,
  filePatterns: ["src/checkout/**"],
  schedule: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe.sequential("POST /api/companies/:companyId/test-plans", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestPlanService)) mock.mockReset();
  });

  it("creates a test plan and returns 201", async () => {
    mockTestPlanService.create.mockResolvedValue({ ...samplePlan, id: "plan-new" });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/companies/company-1/test-plans").send({
        name: "Checkout load test",
        engines: ["k6"],
        filePatterns: ["src/checkout/**"],
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("plan-new");
    expect(mockTestPlanService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Checkout load test", engines: ["k6"] }),
    );
  });

  it("returns 422 when engines array is missing", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/companies/company-1/test-plans").send({ name: "No engines" }),
    );

    expect(res.status).toBe(422);
    expect(mockTestPlanService.create).not.toHaveBeenCalled();
  });

  it("returns 422 when name is missing", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-plans")
        .send({ engines: ["k6"] }),
    );

    expect(res.status).toBe(422);
    expect(mockTestPlanService.create).not.toHaveBeenCalled();
  });

  it("accepts optional fields: loadProfile, apmProvider, schedule", async () => {
    mockTestPlanService.create.mockResolvedValue(samplePlan);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/companies/company-1/test-plans").send({
        name: "Full plan",
        engines: ["k6", "playwright"],
        loadProfile: { vus: 50, stages: [{ duration: "5m", target: 50 }] },
        apmProvider: "dynatrace",
        apmServiceId: "svc-checkout",
        schedule: "0 2 * * *",
        filePatterns: ["src/**"],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockTestPlanService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        apmProvider: "dynatrace",
        schedule: "0 2 * * *",
      }),
    );
  });

  it("enforces company scope", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-2/test-plans")
        .send({ name: "Plan", engines: ["k6"] }),
    );

    expect(res.status).toBe(403);
    expect(mockTestPlanService.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-plans")
        .send({ name: "Plan", engines: ["k6"] }),
    );

    expect(res.status).toBe(401);
  });
});

describe.sequential("GET /api/companies/:companyId/test-plans", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestPlanService)) mock.mockReset();
  });

  it("returns list of test plans for the company", async () => {
    mockTestPlanService.list.mockResolvedValue([samplePlan]);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/test-plans"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("plan-1");
  });

  it("returns empty array when no plans exist", async () => {
    mockTestPlanService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/test-plans"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("enforces company scope", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-2/test-plans"),
    );

    expect(res.status).toBe(403);
    expect(mockTestPlanService.list).not.toHaveBeenCalled();
  });
});

describe.sequential("GET /api/test-plans/:id", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestPlanService)) mock.mockReset();
  });

  it("returns the test plan by id", async () => {
    mockTestPlanService.getById.mockResolvedValue(samplePlan);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/test-plans/plan-1"),
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("plan-1");
    expect(res.body.engines).toContain("k6");
  });

  it("returns 404 for unknown id", async () => {
    mockTestPlanService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/test-plans/missing"),
    );

    expect(res.status).toBe(404);
  });

  it("enforces company scope on get by id", async () => {
    mockTestPlanService.getById.mockResolvedValue({
      ...samplePlan,
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/test-plans/plan-1"),
    );

    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base).get("/api/test-plans/plan-1"),
    );

    expect(res.status).toBe(401);
  });
});
