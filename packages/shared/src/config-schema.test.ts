import { describe, expect, it } from "vitest";
import { sentinelConfigSchema } from "./config-schema.js";

describe("paperclip config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = sentinelConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.sentinel/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.sentinel/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.sentinel/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.sentinel/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.sentinel/instances/default/secrets/master.key");
  });
});
