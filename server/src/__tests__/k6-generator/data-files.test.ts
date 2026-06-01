// server/src/__tests__/k6-generator/data-files.test.ts
import { describe, expect, it } from 'vitest';
import { buildDataFiles } from '../../services/k6-generator/data-files.js';
import type { Workflow } from '../../services/k6-generator/types.js';

const wf = (name: string, dataStrategy: Workflow['dataStrategy']): Workflow => ({
  name, weight: 1, request: { method: 'GET', path: `/${name}` }, dataStrategy,
});

describe('buildDataFiles', () => {
  it('emits reusable.json when any workflow uses reusable data', () => {
    const out = buildDataFiles([wf('search', 'reusable')], { reusable: [{ term: 'a' }, { term: 'b' }] });
    expect(out.dataFiles).toEqual([{ name: 'reusable.json', content: JSON.stringify([{ term: 'a' }, { term: 'b' }]), type: 'json', strategy: 'reusable' }]);
    expect(out.hasReusable).toBe(true);
    expect(out.hasConsumable).toBe(false);
  });

  it('emits consumable.json and reports record count for the volume check', () => {
    const out = buildDataFiles([wf('checkout', 'consumable')], { consumable: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(out.hasConsumable).toBe(true);
    expect(out.consumableCount).toBe(3);
    expect(out.dataFiles.find((f) => f.name === 'consumable.json')?.strategy).toBe('consumable');
  });

  it('defaults to an empty reusable file when reusable is required but no records supplied', () => {
    const out = buildDataFiles([wf('search', 'reusable')], {});
    expect(out.dataFiles.find((f) => f.name === 'reusable.json')?.content).toBe('[]');
  });

  it('emits no data files when all workflows use dataStrategy none', () => {
    const out = buildDataFiles([wf('ping', 'none')], {});
    expect(out.dataFiles).toEqual([]);
    expect(out.hasReusable).toBe(false);
  });
});
