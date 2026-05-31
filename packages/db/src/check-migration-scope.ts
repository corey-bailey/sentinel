import { readdir, readFile, unlink } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const scopePath = fileURLToPath(new URL("./migrations/.next-scope.txt", import.meta.url));

export function parseScope(raw: string): Set<string> {
  return new Set(
    raw
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
      .map((line) => line.toLowerCase()),
  );
}

export function extractTouchedTables(sql: string): Set<string> {
  const touched = new Set<string>();
  const patterns = [
    /(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
    /\bON\s+"?([a-z_][a-z0-9_]*)"?\s*(?:USING\s+\w+\s*)?\(/gi,
    /\bREFERENCES\s+(?:"public"\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi,
  ];
  for (const re of patterns) {
    for (const match of sql.matchAll(re)) {
      touched.add(match[1].toLowerCase());
    }
  }
  return touched;
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => /^\d{4}_.*\.sql$/.test(entry))
    .sort();

  const latest = migrationFiles.at(-1);
  if (!latest) {
    throw new Error("No migrations found");
  }

  let scopeRaw: string;
  try {
    scopeRaw = await readFile(scopePath, "utf8");
  } catch {
    throw new Error(
      `Missing scope declaration at ${scopePath}.\n` +
        `Create it listing the tables you intend to touch, one per line, then re-run pnpm generate.\n` +
        `Example contents:\n  # reason: add archived column\n  projects\n`,
    );
  }

  const declared = parseScope(scopeRaw);
  if (declared.size === 0) {
    throw new Error(`Scope declaration ${scopePath} is empty. List at least one table.`);
  }

  const sql = await readFile(`${migrationsDir}/${latest}`, "utf8");
  const touched = extractTouchedTables(sql);

  const unexpected = [...touched].filter((t) => !declared.has(t));
  if (unexpected.length > 0) {
    throw new Error(
      `Generated migration ${latest} touches tables not in .next-scope.txt:\n` +
        unexpected.map((t) => `  - ${t}`).join("\n") +
        `\n\nEither (a) add them to .next-scope.txt if intended, or ` +
        `(b) revert the schema drift in src/schema/ and re-run pnpm generate.`,
    );
  }

  await unlink(scopePath);
  console.log(`✓ migration scope ok (${[...touched].sort().join(", ")})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
