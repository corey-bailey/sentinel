import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/index.js';

const create = vi.fn();
const runExecutionTrigger = vi.fn();
vi.mock('../services/pipeline-run.js', () => ({ pipelineRunService: () => ({ create, runExecutionTrigger }) }));
const { pipelineRunsRoutes } = await import('../routes/pipeline-runs.js');

function buildApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  const api = express.Router();
  api.use(pipelineRunsRoutes({} as never));
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

describe.sequential('POST /api/companies/:companyId/pipeline-runs', () => {
  afterEach(() => { create.mockReset(); runExecutionTrigger.mockReset(); });

  it('creates + runs an execution-trigger run and returns 201 with the verdict', async () => {
    create.mockResolvedValue({ id: 'pr-1' });
    runExecutionTrigger.mockResolvedValue({ verdict: 'pass', ciSignal: 'pass' });
    const res = await request(buildApp(board(['company-1'])))
      .post('/api/companies/company-1/pipeline-runs')
      .send({ testPlanId: '00000000-0000-0000-0000-000000000001', requirementsDocumentId: '00000000-0000-0000-0000-000000000002', trigger: { type: 'manual_rerun', source: 'api' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pipelineRunId: 'pr-1', verdict: 'pass', ciSignal: 'pass' });
    expect(create).toHaveBeenCalledOnce();
    expect(runExecutionTrigger).toHaveBeenCalledWith('pr-1', expect.anything());
  });

  it('422 on invalid body', async () => {
    const res = await request(buildApp(board(['company-1']))).post('/api/companies/company-1/pipeline-runs').send({ trigger: { type: 'manual_rerun', source: 'api' } });
    expect(res.status).toBe(422);
  });

  it('403 when actor lacks company access', async () => {
    const res = await request(buildApp(board(['other']))).post('/api/companies/company-1/pipeline-runs').send({ testPlanId: '00000000-0000-0000-0000-000000000001', requirementsDocumentId: '00000000-0000-0000-0000-000000000002', trigger: { type: 'manual_rerun', source: 'api' } });
    expect(res.status).toBe(403);
  });
});
