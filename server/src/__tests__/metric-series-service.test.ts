import { describe, expect, it } from 'vitest';
import { metricSeries, testRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { metricSeriesService } from '../services/metric-series.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('metricSeriesService.ingest', () => {
  const ctx = withPipelineSchema([metricSeries, testRuns, testPlans]);

  it('writes one row per series entry with tags, sampleCount, and normalized values', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan.id }).returning();

    const svc = metricSeriesService(ctx.db);
    const created = await svc.ingest(ctx.companyId, {
      testRunId: run.id,
      source: 'k6',
      series: [
        { metric: 'p95_ms', workflowName: 'checkout', phase: 'steady', value: 180, sampleCount: 1200 },
        { metric: 'error_rate', workflowName: 'checkout', phase: 'steady', value: 0.004, sampleCount: 1200 },
      ],
    });

    expect(created).toHaveLength(2);
    const rows = await ctx.db.select().from(metricSeries).where(eq(metricSeries.testRunId, run.id));
    expect(rows).toHaveLength(2);
    const p95 = rows.find((r) => r.metric === 'p95_ms');
    expect(p95?.workflowName).toBe('checkout');
    expect(p95?.phase).toBe('steady');
    expect(p95?.value).toBe(180);
    expect(p95?.sampleCount).toBe(1200);
    expect(p95?.source).toBe('k6');
  });
});
