// server/src/__tests__/k6-generator/template.test.ts
import { describe, expect, it } from 'vitest';
import { K6_IMPORTS, fixedHelpers, handleSummarySource } from '../../services/k6-generator/template.js';

describe('template fragments', () => {
  it('imports the http/exec/data modules and the reporter libs', () => {
    expect(K6_IMPORTS).toContain('import http from "k6/http"');
    expect(K6_IMPORTS).toContain('import exec from "k6/execution"');
    expect(K6_IMPORTS).toContain('k6-reporter');
    expect(K6_IMPORTS).toContain('k6-summary');
  });

  it('phaseFor is 4-branch, converts ms→s, and params stamps {workflow,phase}', () => {
    const h = fixedHelpers();
    expect(h).toContain('function phaseFor(t)');
    expect(h).toContain('var ts = t / 1000');           // k6 currentTestRunDuration is MILLISECONDS
    expect(h).toContain('return "warmup"');
    expect(h).toContain('return "steady"');
    expect(h).toContain('tags: { workflow: workflow, phase: phase }');
    expect(h).toContain('function claimConsumable()');
    expect(h).toContain('exec.scenario.iterationInTest'); // NOT exec.vu.idInTest
    expect(h).not.toContain('exec.vu.idInTest');
  });

  it('handleSummary writes the html report, the RAW k6 summary json, and stdout — no Sentinel payload', () => {
    const src = handleSummarySource();
    expect(src).toContain('export function handleSummary(data)');
    expect(src).toContain('"summary-" + TEST_RUN_ID + ".html"');
    expect(src).toContain('"summary-" + TEST_RUN_ID + ".json"');
    expect(src).toContain('JSON.stringify(data)');       // raw k6 summary, not a shaped ingestion payload
    expect(src).toContain('htmlReport(data)');
    expect(src).toContain('textSummary(data');
    expect(src).not.toContain('buildIngestionSeries');   // the transform lives in the harness (Task 5)
  });
});
