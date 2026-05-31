import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  createDb,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from '@sentinel/db';
import { companies } from '@sentinel/db';

export type Db = ReturnType<typeof createDb>;

export interface SchemaTestContext {
  get db(): Db;
  get companyId(): string;
}

/**
 * Spins up an isolated embedded Postgres (migrations auto-applied), seeds one
 * company per test, and cleans the named tables after each test. Returns a
 * context whose getters are valid inside `it()` blocks. Caller passes the list
 * of tables to truncate after each test, child-before-parent (FK order).
 */
export function withPipelineSchema(
  cleanupTables: { delete: unknown }[],
): SchemaTestContext {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase('sentinel-schema-');
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeAll(async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: 'Test Co', status: 'active' })
      .returning();
    companyId = company.id;
  });

  afterEach(async () => {
    for (const table of cleanupTables) {
      // @ts-expect-error drizzle delete typing across heterogeneous tables
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  return {
    get db() {
      return db;
    },
    get companyId() {
      return companyId;
    },
  };
}

export const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
