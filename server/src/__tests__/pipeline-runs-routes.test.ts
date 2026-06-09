import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { errorHandler } from '../middleware/index.js';

const create = vi.fn();
const runExecutionTrigger = vi.fn();
const list = vi.fn();
const getDetail = vi.fn();
vi.mock('../services/pipeline-run.js', () => ({ pipelineRunService: () => ({ create, runExecutionTrigger, list, getDetail }) }));
const { pipelineRunsRoutes } = await import('../routes/pipeline-runs.js');

// Stub db for the artifact route (the only direct db query in this router).
function stubDb(artifactRows: unknown[]) {
  return { select: () => ({ from: () => ({ where: async () => artifactRows }) }) } as never;
}

type StorageStub = { getObject: ReturnType<typeof vi.fn> };
function buildApp(actor: unknown, opts: { db?: never; storage?: StorageStub } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  const api = express.Router();
  api.use(pipelineRunsRoutes(opts.db ?? ({} as never), opts.storage as never));
  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
// board user with an ACTIVE admin membership for each company in companyIds —
// required because assertCompanyAccess checks memberships on mutating (POST) requests.
// The 403 case is exercised by passing an actor WITHOUT access to company-1.
const board = (companyIds: string[]) => ({
  type: 'board',
  userId: 'u1',
  companyIds,
  isInstanceAdmin: false,
  memberships: companyIds.map((companyId) => ({ companyId, status: 'active', membershipRole: 'admin' })),
});

const validBody = {
  testPlanId: '00000000-0000-0000-0000-000000000001',
  requirementsDocumentId: '00000000-0000-0000-0000-000000000002',
  trigger: { type: 'manual_rerun', source: 'api' },
};

describe.sequential('POST /api/companies/:companyId/pipeline-runs', () => {
  afterEach(() => { create.mockReset(); runExecutionTrigger.mockReset(); list.mockReset(); getDetail.mockReset(); });

  it('wait:true creates + runs synchronously and returns 201 with the verdict', async () => {
    create.mockResolvedValue({ id: 'pr-1' });
    runExecutionTrigger.mockResolvedValue({ verdict: 'pass', ciSignal: 'pass' });
    const res = await request(buildApp(board(['company-1'])))
      .post('/api/companies/company-1/pipeline-runs')
      .send({ ...validBody, wait: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pipelineRunId: 'pr-1', verdict: 'pass', ciSignal: 'pass' });
    expect(create).toHaveBeenCalledOnce();
    expect(runExecutionTrigger).toHaveBeenCalledWith('pr-1', expect.anything());
  });

  it('default (no wait) responds 201 running immediately and runs in the background', async () => {
    create.mockResolvedValue({ id: 'pr-2' });
    let resolveRun: (v: unknown) => void = () => {};
    runExecutionTrigger.mockReturnValue(new Promise((r) => { resolveRun = r; }));
    const res = await request(buildApp(board(['company-1'])))
      .post('/api/companies/company-1/pipeline-runs')
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pipelineRunId: 'pr-2', verdict: 'running', ciSignal: null });
    expect(runExecutionTrigger).toHaveBeenCalledWith('pr-2', expect.anything());
    resolveRun({ verdict: 'pass', ciSignal: 'pass' });
  });

  it('422 on invalid body', async () => {
    const res = await request(buildApp(board(['company-1']))).post('/api/companies/company-1/pipeline-runs').send({ trigger: { type: 'manual_rerun', source: 'api' } });
    expect(res.status).toBe(422);
  });

  it('403 when actor lacks company access', async () => {
    const res = await request(buildApp(board(['other']))).post('/api/companies/company-1/pipeline-runs').send(validBody);
    expect(res.status).toBe(403);
  });
});

describe.sequential('GET pipeline-run read routes', () => {
  afterEach(() => { create.mockReset(); runExecutionTrigger.mockReset(); list.mockReset(); getDetail.mockReset(); });

  it('GET /companies/:companyId/pipeline-runs lists runs', async () => {
    list.mockResolvedValue([{ id: 'pr-1', companyId: 'company-1' }]);
    const res = await request(buildApp(board(['company-1']))).get('/api/companies/company-1/pipeline-runs?testPlanId=tp-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'pr-1', companyId: 'company-1' }]);
    expect(list).toHaveBeenCalledWith('company-1', { testPlanId: 'tp-1' });
  });

  it('GET list 403 for foreign company', async () => {
    const res = await request(buildApp(board(['other']))).get('/api/companies/company-1/pipeline-runs');
    expect(res.status).toBe(403);
  });

  it('GET /pipeline-runs/:id returns the detail', async () => {
    getDetail.mockResolvedValue({ id: 'pr-1', companyId: 'company-1', slaVerdicts: [], artifacts: [] });
    const res = await request(buildApp(board(['company-1']))).get('/api/pipeline-runs/pr-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'pr-1' });
  });

  it('GET /pipeline-runs/:id 404 when missing', async () => {
    getDetail.mockResolvedValue(null);
    const res = await request(buildApp(board(['company-1']))).get('/api/pipeline-runs/nope');
    expect(res.status).toBe(404);
  });
});

describe.sequential('GET /api/artifacts/:artifactId/content', () => {
  afterEach(() => { create.mockReset(); runExecutionTrigger.mockReset(); list.mockReset(); getDetail.mockReset(); });

  it('404 for an unknown artifact', async () => {
    const res = await request(buildApp(board(['company-1']), { db: stubDb([]) })).get('/api/artifacts/a-1/content');
    expect(res.status).toBe(404);
  });

  it('streams a legacy on-disk HTML artifact with sandbox CSP', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-artifact-test-'));
    const file = path.join(dir, 'summary.html');
    await fs.writeFile(file, '<html>report</html>');
    const artifact = { id: 'a-1', companyId: 'company-1', storageRef: file, contentType: 'text/html' };
    const res = await request(buildApp(board(['company-1']), { db: stubDb([artifact]) })).get('/api/artifacts/a-1/content');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toBe('sandbox allow-scripts');
    expect(res.text).toBe('<html>report</html>');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('410 when a legacy temp-dir artifact file no longer exists', async () => {
    const artifact = { id: 'a-1', companyId: 'company-1', storageRef: '/tmp/sentinel-run-gone/summary.html', contentType: 'text/html' };
    const res = await request(buildApp(board(['company-1']), { db: stubDb([artifact]) })).get('/api/artifacts/a-1/content');
    expect(res.status).toBe(410);
  });

  it('streams an objectKey artifact from the storage service as JSON', async () => {
    const storage: StorageStub = {
      getObject: vi.fn().mockResolvedValue({ stream: Readable.from('{"ok":true}'), contentLength: 11 }),
    };
    const artifact = { id: 'a-2', companyId: 'company-1', storageRef: 'company-1/pipeline-runs/pr-1/summary.json', contentType: 'application/json' };
    const res = await request(buildApp(board(['company-1']), { db: stubDb([artifact]), storage })).get('/api/artifacts/a-2/content');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ ok: true });
    expect(storage.getObject).toHaveBeenCalledWith('company-1', 'company-1/pipeline-runs/pr-1/summary.json');
  });

  it('410 when the storage object is missing', async () => {
    const storage: StorageStub = { getObject: vi.fn().mockRejectedValue(new Error('not found')) };
    const artifact = { id: 'a-3', companyId: 'company-1', storageRef: 'company-1/pipeline-runs/pr-1/summary.json', contentType: 'application/json' };
    const res = await request(buildApp(board(['company-1']), { db: stubDb([artifact]), storage })).get('/api/artifacts/a-3/content');
    expect(res.status).toBe(410);
  });

  it('403 when actor lacks access to the artifact company', async () => {
    const artifact = { id: 'a-4', companyId: 'company-1', storageRef: '/tmp/x.html', contentType: 'text/html' };
    const res = await request(buildApp(board(['other']), { db: stubDb([artifact]) })).get('/api/artifacts/a-4/content');
    expect(res.status).toBe(403);
  });
});
