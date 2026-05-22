import assert from "node:assert/strict";
import test from "node:test";

import {
  collectInternalDependencyProblems,
  createManifestLookupKey,
  fetchRegistryJson,
  isCanaryVersion,
  verifyPackageRegistryProblems,
  verifyPackageRegistryState,
} from "./verify-release-registry-state.mjs";

test("isCanaryVersion matches release canaries", () => {
  assert.equal(isCanaryVersion("2026.427.0-canary.3"), true);
  assert.equal(isCanaryVersion("2026.427.0"), false);
});

test("collectInternalDependencyProblems flags missing internal versions", () => {
  const manifest = {
    dependencies: {
      "@sentinel/plugin-sdk": "2026.425.0-canary.5",
      e2b: "^2.19.0",
    },
  };
  const packageDocsByName = new Map([
    [
      "@sentinel/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, packageDocsByName),
    ["dependencies requires @sentinel/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version"],
  );
});

test("collectInternalDependencyProblems accepts version-specific manifests when the root document is stale", () => {
  const manifest = {
    dependencies: {
      "@sentinel/plugin-sdk": "2026.425.0-canary.5",
    },
  };
  const packageDocsByName = new Map([
    [
      "@sentinel/plugin-sdk",
      {
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@sentinel/plugin-sdk", "2026.425.0-canary.5"),
      { name: "@sentinel/plugin-sdk", version: "2026.425.0-canary.5" },
    ],
  ]);

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, packageDocsByName, packageManifestsByKey),
    [],
  );
});

test("collectInternalDependencyProblems ignores peer dependency range specifiers", () => {
  const manifest = {
    peerDependencies: {
      "@sentinel/server": "^2026.430.0-canary.0",
    },
  };

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, new Map()),
    [],
  );
});

test("collectInternalDependencyProblems reports unfetched transitive dependency metadata neutrally", () => {
  const manifest = {
    optionalDependencies: {
      "@sentinel/browser": "2026.430.0-canary.0",
    },
  };

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, new Map()),
    [
      "optionalDependencies requires @sentinel/browser@2026.430.0-canary.0, but npm publication metadata was not fetched for that dependency",
    ],
  );
});

test("verifyPackageRegistryState tolerates a stale root versions map when dist-tags and direct manifests are correct", () => {
  const packageDocsByName = new Map([
    [
      "@sentinel/ui",
      {
        "dist-tags": {
          canary: "2026.430.0-canary.0",
          latest: "2026.430.0",
        },
        versions: {},
      },
    ],
    [
      "@sentinel/shared",
      {
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@sentinel/ui", "2026.430.0-canary.0"),
      {
        name: "@sentinel/ui",
        version: "2026.430.0-canary.0",
        dependencies: {
          "@sentinel/shared": "2026.430.0-canary.0",
        },
      },
    ],
    [
      createManifestLookupKey("@sentinel/shared", "2026.430.0-canary.0"),
      {
        name: "@sentinel/shared",
        version: "2026.430.0-canary.0",
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@sentinel/ui",
      packageDoc: packageDocsByName.get("@sentinel/ui"),
      packageDocsByName,
      packageManifestsByKey,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.430.0-canary.0",
      allowCanaryLatest: false,
    }),
    [],
  );
});

test("verifyPackageRegistryState fails when canary latest is left in place by default", () => {
  const packageDocsByName = new Map([
    [
      "@sentinel/plugin-e2b",
      {
        "dist-tags": {
          latest: "2026.425.0-canary.5",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.425.0-canary.5": {
            dependencies: {
              "@sentinel/plugin-sdk": "2026.425.0-canary.5",
            },
          },
          "2026.427.0-canary.3": {
            dependencies: {
              "@sentinel/plugin-sdk": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@sentinel/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@sentinel/plugin-e2b",
      packageDoc: packageDocsByName.get("@sentinel/plugin-e2b"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.427.0-canary.3",
      allowCanaryLatest: false,
    }),
    [
      "@sentinel/plugin-e2b: latest dist-tag still resolves to canary 2026.425.0-canary.5; if that state is intentional, rerun the verification script directly with --allow-canary-latest",
      "@sentinel/plugin-e2b@2026.425.0-canary.5 via latest: dependencies requires @sentinel/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version",
    ],
  );
});

test("verifyPackageRegistryProblems marks canary latest drift as non-retriable", () => {
  const packageDocsByName = new Map([
    [
      "@sentinel/plugin-e2b",
      {
        "dist-tags": {
          latest: "2026.425.0-canary.5",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  const problems = verifyPackageRegistryProblems({
    packageName: "@sentinel/plugin-e2b",
    packageDoc: packageDocsByName.get("@sentinel/plugin-e2b"),
    packageDocsByName,
    channel: "canary",
    distTag: "canary",
    targetVersion: "2026.427.0-canary.3",
    allowCanaryLatest: false,
  });

  assert.equal(problems[0]?.retriable, false);
  assert.match(problems[0]?.message ?? "", /latest dist-tag still resolves to canary/);
});

test("verifyPackageRegistryState allows intentional canary latest but still checks dependencies", () => {
  const packageDocsByName = new Map([
    [
      "sentinelai",
      {
        "dist-tags": {
          latest: "2026.427.0-canary.3",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.427.0-canary.3": {
            dependencies: {
              "@sentinel/server": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@sentinel/server",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "sentinelai",
      packageDoc: packageDocsByName.get("sentinelai"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.427.0-canary.3",
      allowCanaryLatest: true,
    }),
    [],
  );
});

test("verifyPackageRegistryState still fails when the dist-tag is stale", () => {
  const packageDocsByName = new Map([
    [
      "@sentinel/ui",
      {
        "dist-tags": {
          canary: "2026.429.0-canary.2",
        },
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@sentinel/ui", "2026.430.0-canary.0"),
      {
        name: "@sentinel/ui",
        version: "2026.430.0-canary.0",
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@sentinel/ui",
      packageDoc: packageDocsByName.get("@sentinel/ui"),
      packageDocsByName,
      packageManifestsByKey,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.430.0-canary.0",
      allowCanaryLatest: false,
    }),
    ["@sentinel/ui: dist-tag canary resolves to 2026.429.0-canary.2, expected 2026.430.0-canary.0"],
  );
});

test("verifyPackageRegistryState ignores internal peer dependency ranges", () => {
  const packageDocsByName = new Map([
    [
      "@sentinel/plugin-sdk",
      {
        "dist-tags": {
          canary: "2026.430.0-canary.0",
        },
        versions: {
          "2026.430.0-canary.0": {
            peerDependencies: {
              "@sentinel/server": "^2026.430.0-canary.0",
            },
          },
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@sentinel/plugin-sdk",
      packageDoc: packageDocsByName.get("@sentinel/plugin-sdk"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.430.0-canary.0",
      allowCanaryLatest: false,
    }),
    [],
  );
});

test("fetchRegistryJson times out hung requests", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });

  try {
    await assert.rejects(
      fetchRegistryJson(new URL("https://registry.npmjs.org/@sentinelai%2Fui"), { timeoutMs: 1 }),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
