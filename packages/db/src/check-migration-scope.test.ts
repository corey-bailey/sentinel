import { describe, expect, it } from "vitest";
import { extractTouchedTables, parseScope } from "./check-migration-scope.js";

describe("parseScope", () => {
  it("strips comments and whitespace, lowercases, drops empty lines", () => {
    const raw = `# scope for next generate\nProjects\n  agents  # rename column\n\n# bare comment\nAGENT_RUNS\n`;
    expect([...parseScope(raw)].sort()).toEqual(["agent_runs", "agents", "projects"]);
  });

  it("returns empty set for blank or comment-only input", () => {
    expect(parseScope("").size).toBe(0);
    expect(parseScope("# only comments\n# nothing else\n").size).toBe(0);
  });
});

describe("extractTouchedTables", () => {
  it("captures CREATE TABLE with quoted and unquoted names", () => {
    const sql = `CREATE TABLE "upstream_health_state" (id uuid);\nCREATE TABLE IF NOT EXISTS foo (x int);`;
    expect([...extractTouchedTables(sql)].sort()).toEqual(["foo", "upstream_health_state"]);
  });

  it("captures ALTER TABLE and DROP TABLE", () => {
    const sql = `ALTER TABLE "projects" ADD COLUMN archived boolean;\nDROP TABLE IF EXISTS "legacy_jobs";`;
    expect([...extractTouchedTables(sql)].sort()).toEqual(["legacy_jobs", "projects"]);
  });

  it("captures CREATE INDEX target tables", () => {
    const sql = `CREATE UNIQUE INDEX "uq" ON "documents" ("title");\nCREATE INDEX "g" ON "documents" USING gin ("title" gin_trgm_ops);`;
    expect([...extractTouchedTables(sql)].sort()).toEqual(["documents"]);
  });

  it("captures REFERENCES targets including public schema prefix", () => {
    const sql = `ALTER TABLE "a" ADD CONSTRAINT fk FOREIGN KEY ("b") REFERENCES "public"."companies"("id");`;
    expect([...extractTouchedTables(sql)].sort()).toEqual(["a", "companies"]);
  });

  it("returns empty set for SQL with no table references", () => {
    expect(extractTouchedTables("-- noop\nSELECT 1;").size).toBe(0);
  });
});
