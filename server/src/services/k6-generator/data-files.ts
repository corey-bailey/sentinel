// server/src/services/k6-generator/data-files.ts
import type { GeneratedDataFile, Workflow } from './types.js';

export type DataFilePlan = {
  dataFiles: GeneratedDataFile[];
  hasReusable: boolean;
  hasConsumable: boolean;
  consumableCount: number;
};

export function buildDataFiles(
  workflows: Workflow[],
  data: { reusable?: unknown[]; consumable?: unknown[] } = {},
): DataFilePlan {
  const hasReusable = workflows.some((w) => w.dataStrategy === 'reusable' || w.dataStrategy === 'mixed' as never);
  const hasConsumable = workflows.some((w) => w.dataStrategy === 'consumable' || w.dataStrategy === 'mixed' as never);

  const dataFiles: GeneratedDataFile[] = [];
  if (hasReusable) {
    dataFiles.push({ name: 'reusable.json', content: JSON.stringify(data.reusable ?? []), type: 'json', strategy: 'reusable' });
  }
  const consumable = data.consumable ?? [];
  if (hasConsumable) {
    dataFiles.push({ name: 'consumable.json', content: JSON.stringify(consumable), type: 'json', strategy: 'consumable' });
  }

  return { dataFiles, hasReusable, hasConsumable, consumableCount: hasConsumable ? consumable.length : 0 };
}
