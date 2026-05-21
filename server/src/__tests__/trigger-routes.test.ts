import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTriggerService = vi.hoisted(() => ({
  deployWebhook: vi.fn(),
}));

vi.mock("../services/triggers.js", () => ({
  triggerService: () => mockTriggerService,
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
    const [{ errorHandler }, { triggerRoutes }] = await Promise.all([
      import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
      import("../routes/triggers.js") as Promise<{ triggerRoutes: (db: any) => express.Router }>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", triggerRoutes({} as any));
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

describe.sequential("POST /api/companies/:companyId/triggers/deploy", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTriggerService)) mock.mockReset();
  });

  it("accepts repo + commit + changed_files payload and returns run_ids", async () => {
    mockTriggerService.deployWebhook.mockResolvedValue({ runIds: ["run-1", "run-2"] });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/triggers/deploy")
        .send({
          repo: "org/repo",
          commit: "abc123",
          changedFiles: ["src/checkout.ts"],
        }),
    );

    expect(res.status).toBe(200);
    expect(res.body.runIds).toEqual(["run-1", "run-2"]);
    expect(mockTriggerService.deployWebhook).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ repo: "org/repo", commit: "abc123" }),
    );
  });

  it("returns empty runIds when no plans match changed files", async () => {
    mockTriggerService.deployWebhook.mockResolvedValue({ runIds: [] });

    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/triggers/deploy")
        .send({ repo: "org/repo", commit: "abc123", changedFiles: [] }),
    );

    expect(res.status).toBe(200);
    expect(res.body.runIds).toEqual([]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/triggers/deploy")
        .send({ repo: "r", commit: "c", changedFiles: [] }),
    );

    expect(res.status).toBe(401);
    expect(mockTriggerService.deployWebhook).not.toHaveBeenCalled();
  });

  it("enforces company scope — returns 403 for unauthorized company", async () => {
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
        .post("/api/companies/company-2/triggers/deploy")
        .send({ repo: "r", commit: "c", changedFiles: [] }),
    );

    expect(res.status).toBe(403);
    expect(mockTriggerService.deployWebhook).not.toHaveBeenCalled();
  });

  it("rejects payload missing required fields with 422", async () => {
    const app = await createApp();
    const res = await req(app, (base) =>
      request(base)
        .post("/api/companies/company-1/triggers/deploy")
        .send({ changedFiles: [] }),
    );

    expect(res.status).toBe(422);
    expect(mockTriggerService.deployWebhook).not.toHaveBeenCalled();
  });
});
