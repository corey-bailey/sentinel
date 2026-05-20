import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const metaPollutant = fileURLToPath(new URL("./migrations/meta/CLAUDE.md", import.meta.url));

function removeMetaPollutant() {
  if (existsSync(metaPollutant)) unlinkSync(metaPollutant);
}

function listSqlFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((entry) => /^\d{4}_.*\.sql$/.test(entry))
    .sort();
}

function snapshotMigrationCount(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of listSqlFiles()) {
    const stat = statSync(`${migrationsDir}/${file}`);
    counts.set(file, stat.size);
  }
  return counts;
}

function main() {
  removeMetaPollutant();
  const before = snapshotMigrationCount();

  try {
    execFileSync("pnpm", ["exec", "drizzle-kit", "generate", "--name=__drift_check"], {
      cwd: packageDir,
      stdio: "pipe",
    });
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    const out = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    throw new Error(`drizzle-kit generate failed during drift check:\n${out}`);
  }

  const after = snapshotMigrationCount();
  const newFiles = [...after.keys()].filter((f) => !before.has(f));

  if (newFiles.length > 0) {
    for (const file of newFiles) {
      try {
        unlinkSync(`${migrationsDir}/${file}`);
      } catch {
        // best-effort cleanup
      }
    }
    throw new Error(
      `Schema drift detected: drizzle-kit generate produced ${newFiles.length} new migration file(s):\n` +
        newFiles.map((f) => `  - ${f}`).join("\n") +
        `\n\nThe schema in packages/db/src/schema/ has diverged from the migrations. ` +
        `Either commit a real migration via pnpm generate, or revert the schema-file change.`,
    );
  }

  console.log("✓ no schema drift (db:generate produces no new migrations)");
}

main();
