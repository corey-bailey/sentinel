import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTestAssetService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  getCoverageMap: vi.fn(),
}));

vi.mock("../services/test-assets.js", () => ({
  testAssetService: () => mockTestAssetService,
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
    const [{ errorHandler }, { testAssetRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/test-assets.js") as Promise<{ testAssetRoutes: (db: any) => express.Router }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", testAssetRoutes({} as any));
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

const sampleAsset = {
  id: "asset-1",
  companyId: "company-1",
  testPlanId: "plan-1",
  engine: "k6",
  assetType: "human_authored",
  scriptContent: "import http from 'k6/http'; export default function() {}",
  version: 1,
  createdAt: new Date(),
};

describe.sequential("POST /api/companies/:companyId/test-assets", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestAssetService)) mock.mockReset();
  });

  it("creates TestAsset with assetType=human_authored by default and returns 201", async () => {
    mockTestAssetService.create.mockResolvedValue(sampleAsset);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-assets")
        .send({
          testPlanId: "plan-1",
          engine: "k6",
          scriptContent: "import http from 'k6/http'; export default function() {}",
        }),
    );

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("asset-1");
    expect(mockTestAssetService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ assetType: "human_authored" }),
    );
  });

  it("validates engine field against allowed values", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-assets")
        .send({
          testPlanId: "plan-1",
          engine: "invalid-engine",
          scriptContent: "...",
        }),
    );

    expect(res.status).toBe(422);
    expect(mockTestAssetService.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/test-assets")
        .send({ testPlanId: "plan-1", engine: "k6", scriptContent: "..." }),
    );

    expect(res.status).toBe(401);
  });
});

describe.sequential("GET /api/companies/:companyId/test-assets", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTestAssetService)) mock.mockReset();
  });

  it("returns list of assets for a company", async () => {
    mockTestAssetService.list.mockResolvedValue([sampleAsset]);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/test-assets"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("returns coverage map when coverage=testPlanId query param is provided", async () => {
    mockTestAssetService.getCoverageMap.mockResolvedValue({
      k6: { covered: true, assetType: "human_authored" },
      playwright: { covered: false, assetType: null },
      pytest: { covered: false, assetType: null },
      mocha: { covered: false, assetType: null },
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/test-assets?coverage=plan-1"),
    );

    expect(res.status).toBe(200);
    expect(res.body.k6.covered).toBe(true);
    expect(res.body.playwright.covered).toBe(false);
    expect(mockTestAssetService.getCoverageMap).toHaveBeenCalledWith("company-1", "plan-1");
  });

  it("marks engine as gap when only generated (unapproved) asset exists", async () => {
    mockTestAssetService.getCoverageMap.mockResolvedValue({
      k6: { covered: false, assetType: "generated" },
      playwright: { covered: false, assetType: null },
      pytest: { covered: false, assetType: null },
      mocha: { covered: false, assetType: null },
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).get("/api/companies/company-1/test-assets?coverage=plan-1"),
    );

    expect(res.status).toBe(200);
    expect(res.body.k6.covered).toBe(false);
    expect(res.body.k6.assetType).toBe("generated");
  });
});
