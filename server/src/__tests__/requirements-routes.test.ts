import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequirementService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../services/requirements.js", () => ({
  requirementService: () => mockRequirementService,
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
    const [{ errorHandler }, { requirementRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/requirements.js") as Promise<{ requirementRoutes: (db: any) => express.Router }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", requirementRoutes({} as any));
    app.use(errorHandler);
    return app;
  })();
}

async function req(
  app: express.Express,
  buildReq: (baseUrl: string) => request.Test,
) {
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

const sampleSlaTargets = [
  { metric: "p95Ms", operator: "lt", threshold: 200, source: "k6" },
];

describe.sequential("POST /api/companies/:companyId/requirements", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockRequirementService)) mock.mockReset();
  });

  it("creates Requirement and returns 201 with id", async () => {
    mockRequirementService.create.mockResolvedValue({
      id: "req-1",
      companyId: "company-1",
      name: "Checkout SLA",
      slaTargets: sampleSlaTargets,
      source: "human",
      coverageStatus: "unknown",
      createdAt: new Date(),
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/requirements")
        .send({ name: "Checkout SLA", slaTargets: sampleSlaTargets }),
    );

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("req-1");
    expect(mockRequirementService.create).toHaveBeenCalledOnce();
  });

  it("rejects unknown sla_targets source", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/requirements")
        .send({
          name: "Bad source",
          slaTargets: [{ metric: "p95Ms", operator: "lt", threshold: 200, source: "invalid" }],
        }),
    );

    expect(res.status).toBe(422);
    expect(mockRequirementService.create).not.toHaveBeenCalled();
  });

  it("rejects unknown sla_targets operator", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/requirements")
        .send({
          name: "Bad op",
          slaTargets: [{ metric: "p95Ms", operator: "eq", threshold: 200, source: "k6" }],
        }),
    );

    expect(res.status).toBe(422);
    expect(mockRequirementService.create).not.toHaveBeenCalled();
  });

  it("accepts jira_issue_id as optional field", async () => {
    mockRequirementService.create.mockResolvedValue({
      id: "req-2",
      companyId: "company-1",
      name: "Jira req",
      slaTargets: sampleSlaTargets,
      source: "human",
      jiraIssueId: "PROJ-123",
      coverageStatus: "unknown",
      createdAt: new Date(),
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/requirements")
        .send({ name: "Jira req", slaTargets: sampleSlaTargets, jiraIssueId: "PROJ-123" }),
    );

    expect(res.status).toBe(201);
    expect(res.body.jiraIssueId).toBe("PROJ-123");
  });

  it("sets source=human when created via board user", async () => {
    mockRequirementService.create.mockResolvedValue({
      id: "req-3",
      companyId: "company-1",
      name: "Human req",
      slaTargets: sampleSlaTargets,
      source: "human",
      coverageStatus: "unknown",
      createdAt: new Date(),
    });

    const app = await createApp();
    await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/requirements")
        .send({ name: "Human req", slaTargets: sampleSlaTargets }),
    );

    expect(mockRequirementService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ source: "human" }),
    );
  });

  it("sets source=agent when created via agent JWT", async () => {
    mockRequirementService.create.mockResolvedValue({
      id: "req-4",
      companyId: "company-1",
      name: "Agent req",
      slaTargets: sampleSlaTargets,
      source: "agent",
      coverageStatus: "unknown",
      createdAt: new Date(),
    });

    const agentActor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "jwt",
      companyIds: ["company-1"],
    };
    const app = await createApp(agentActor);
    await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/requirements")
        .send({ name: "Agent req", slaTargets: sampleSlaTargets }),
    );

    expect(mockRequirementService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ source: "agent" }),
    );
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/requirements")
        .send({ name: "x", slaTargets: sampleSlaTargets }),
    );

    expect(res.status).toBe(401);
    expect(mockRequirementService.create).not.toHaveBeenCalled();
  });

  it("enforces company scope — user without access gets 403", async () => {
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
        .post("/api/companies/company-2/requirements")
        .send({ name: "x", slaTargets: sampleSlaTargets }),
    );

    expect(res.status).toBe(403);
    expect(mockRequirementService.create).not.toHaveBeenCalled();
  });
});

describe.sequential("GET /api/requirements/:id", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockRequirementService)) mock.mockReset();
  });

  it("returns Requirement with coverageStatus field", async () => {
    mockRequirementService.getById.mockResolvedValue({
      id: "req-1",
      companyId: "company-1",
      name: "Checkout SLA",
      slaTargets: sampleSlaTargets,
      source: "human",
      coverageStatus: "covered",
      createdAt: new Date(),
    });

    const app = await createApp();
    const res = await req(app, (base) => request(base).get("/api/requirements/req-1"));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("req-1");
    expect(res.body.coverageStatus).toBe("covered");
  });

  it("returns 404 for unknown id", async () => {
    mockRequirementService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await req(app, (base) => request(base).get("/api/requirements/missing"));

    expect(res.status).toBe(404);
  });

  it("enforces company scope", async () => {
    mockRequirementService.getById.mockResolvedValue({
      id: "req-99",
      companyId: "company-2",
      name: "Other company",
      slaTargets: [],
      source: "human",
      coverageStatus: "unknown",
      createdAt: new Date(),
    });

    const app = await createApp();
    const res = await req(app, (base) => request(base).get("/api/requirements/req-99"));

    expect(res.status).toBe(403);
  });
});

describe.sequential("PATCH /api/requirements/:id", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockRequirementService)) mock.mockReset();
  });

  it("updates slaTargets", async () => {
    const existing = {
      id: "req-1",
      companyId: "company-1",
      name: "Checkout SLA",
      slaTargets: sampleSlaTargets,
      source: "human",
      coverageStatus: "covered",
      createdAt: new Date(),
    };
    mockRequirementService.getById.mockResolvedValue(existing);
    mockRequirementService.update.mockResolvedValue({
      ...existing,
      slaTargets: [{ metric: "p99Ms", operator: "lt", threshold: 500, source: "k6" }],
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .patch("/api/requirements/req-1")
        .send({ slaTargets: [{ metric: "p99Ms", operator: "lt", threshold: 500, source: "k6" }] }),
    );

    expect(res.status).toBe(200);
    expect(mockRequirementService.update).toHaveBeenCalledOnce();
  });

  it("returns 404 for unknown id", async () => {
    mockRequirementService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/requirements/missing").send({ name: "x" }),
    );

    expect(res.status).toBe(404);
  });

  it("enforces company scope on PATCH", async () => {
    mockRequirementService.getById.mockResolvedValue({
      id: "req-99",
      companyId: "company-2",
      name: "Other co",
      slaTargets: [],
      source: "human",
      coverageStatus: "unknown",
      createdAt: new Date(),
    });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base).patch("/api/requirements/req-99").send({ name: "changed" }),
    );

    expect(res.status).toBe(403);
    expect(mockRequirementService.update).not.toHaveBeenCalled();
  });
});
