import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBaselineService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  approve: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../services/baselines.js", () => ({
  baselineService: () => mockBaselineService,
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
    const [{ errorHandler }, { baselineRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/baselines.js") as Promise<{ baselineRoutes: (db: any) => express.Router }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", baselineRoutes({} as any));
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

const sampleBaseline = {
  id: "baseline-1",
  companyId: "company-1",
  testPlanId: "plan-1",
  metric: "p95Ms",
  baselineValue: 150,
  tolerancePct: 10,
  isActive: true,
  approvedByUserId: null,
  approvedAt: null,
  createdAt: new Date(),
};

describe.sequential("POST /api/companies/:companyId/baselines", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockBaselineService)) mock.mockReset();
  });

  it("creates a baseline and returns 201", async () => {
    const created = { ...sampleBaseline, id: "baseline-new", isActive: false };
    mockBaselineService.create.mockResolvedValue(created);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/companies/company-1/baselines").send({
        testPlanId: "plan-1",
        sourceRunId: "run-1",
        metric: "p95Ms",
        baselineValue: 150,
        tolerancePct: 10,
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("baseline-new");
    expect(mockBaselineService.create).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", metric: "p95Ms" }),
    );
  });

  it("returns 422 when required fields are missing", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/companies/company-1/baselines").send({ metric: "p95Ms" }),
    );

    expect(res.status).toBe(422);
    expect(mockBaselineService.create).not.toHaveBeenCalled();
  });
});

describe.sequential("GET /api/companies/:companyId/baselines", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockBaselineService)) mock.mockReset();
  });

  it("returns active baselines for the company", async () => {
    mockBaselineService.list.mockResolvedValue([sampleBaseline]);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/baselines"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("baseline-1");
  });

  it("filters by testPlanId when provided", async () => {
    mockBaselineService.list.mockResolvedValue([sampleBaseline]);

    const app = await createApp();
    await req(app, (base) =>
      request(base).get("/api/companies/company-1/baselines?testPlanId=plan-1"),
    );

    expect(mockBaselineService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ testPlanId: "plan-1" }),
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
      request(base).get("/api/companies/company-2/baselines"),
    );

    expect(res.status).toBe(403);
    expect(mockBaselineService.list).not.toHaveBeenCalled();
  });
});

describe.sequential("POST /api/baselines/:id/approve", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockBaselineService)) mock.mockReset();
  });

  it("sets is_active=true and returns updated baseline", async () => {
    mockBaselineService.getById.mockResolvedValue(sampleBaseline);
    mockBaselineService.approve.mockResolvedValue({
      ...sampleBaseline,
      isActive: true,
      approvedByUserId: "user-1",
      approvedAt: new Date(),
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/baselines/baseline-1/approve"),
    );

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    expect(mockBaselineService.approve).toHaveBeenCalledWith("baseline-1", "user-1");
  });

  it("returns 404 for unknown baseline id", async () => {
    mockBaselineService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/baselines/missing/approve"),
    );

    expect(res.status).toBe(404);
    expect(mockBaselineService.approve).not.toHaveBeenCalled();
  });

  it("enforces company scope on approve", async () => {
    mockBaselineService.getById.mockResolvedValue({
      ...sampleBaseline,
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).post("/api/baselines/baseline-1/approve"),
    );

    expect(res.status).toBe(403);
    expect(mockBaselineService.approve).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base).post("/api/baselines/baseline-1/approve"),
    );

    expect(res.status).toBe(401);
  });
});
