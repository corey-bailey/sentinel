import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegressionService = vi.hoisted(() => ({
  getById: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../services/regressions.js", () => ({
  regressionService: () => mockRegressionService,
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
    const [{ errorHandler }, { regressionRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/regressions.js") as Promise<{ regressionRoutes: (db: any) => express.Router }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", regressionRoutes({} as any));
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

const sampleRegression = {
  id: "reg-1",
  companyId: "company-1",
  testRunId: "run-1",
  metric: "p95Ms",
  baselineValue: 150,
  actualValue: 200,
  deviationPct: 33.33,
  status: "open",
  regressionType: "metric_breach",
  createdAt: new Date(),
};

describe.sequential("PATCH /api/regressions/:id (approve)", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockRegressionService)) mock.mockReset();
  });

  it("approve sets status=approved and returns updated regression", async () => {
    mockRegressionService.getById.mockResolvedValue(sampleRegression);
    mockRegressionService.approve.mockResolvedValue({ ...sampleRegression, status: "approved" });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/regressions/reg-1").send({ action: "approve" }),
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(mockRegressionService.approve).toHaveBeenCalledWith("reg-1", "user-1");
  });

  it("reject sets status=rejected and returns updated regression", async () => {
    mockRegressionService.getById.mockResolvedValue(sampleRegression);
    mockRegressionService.reject.mockResolvedValue({ ...sampleRegression, status: "rejected" });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/regressions/reg-1").send({ action: "reject" }),
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(mockRegressionService.reject).toHaveBeenCalledWith("reg-1", "user-1");
  });

  it("returns 409 when regression is already resolved", async () => {
    mockRegressionService.getById.mockResolvedValue({ ...sampleRegression, status: "approved" });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/regressions/reg-1").send({ action: "approve" }),
    );

    expect(res.status).toBe(409);
    expect(mockRegressionService.approve).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown regression id", async () => {
    mockRegressionService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/regressions/missing").send({ action: "approve" }),
    );

    expect(res.status).toBe(404);
  });

  it("enforces company scope", async () => {
    mockRegressionService.getById.mockResolvedValue({ ...sampleRegression, companyId: "company-2" });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/regressions/reg-1").send({ action: "approve" }),
    );

    expect(res.status).toBe(403);
    expect(mockRegressionService.approve).not.toHaveBeenCalled();
  });

  it("rejects invalid action with 422", async () => {
    mockRegressionService.getById.mockResolvedValue(sampleRegression);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/regressions/reg-1").send({ action: "delete" }),
    );

    expect(res.status).toBe(422);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base).patch("/api/regressions/reg-1").send({ action: "approve" }),
    );

    expect(res.status).toBe(401);
  });
});

describe.sequential("GET /api/companies/:companyId/regressions", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockRegressionService)) mock.mockReset();
  });

  it("returns list of regressions for a company", async () => {
    mockRegressionService.list.mockResolvedValue([sampleRegression]);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/regressions"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("reg-1");
  });
});
