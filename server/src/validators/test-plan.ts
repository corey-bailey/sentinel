export type Engine = "k6" | "playwright" | "pytest" | "mocha";

export type LoadStage = {
  duration: string;
  target: number;
};

export type LoadProfile = {
  vus: number;
  stages: LoadStage[];
};

export type TestPlanInput = {
  name: string;
  engines: Engine[];
  loadProfile?: LoadProfile;
  apmProvider?: string;
  apmServiceId?: string;
};

const VALID_ENGINES: Set<string> = new Set(["k6", "playwright", "pytest", "mocha"]);

export function validateTestPlan(input: TestPlanInput): void {
  if (!input.name || input.name.trim() === "") {
    throw new Error("Name is required");
  }

  if (!input.engines || input.engines.length === 0) {
    throw new Error("Engines are required — at least one engine must be specified");
  }

  for (const engine of input.engines) {
    if (!VALID_ENGINES.has(engine)) {
      throw new Error(`Invalid engine: "${engine}". Valid engines are: ${[...VALID_ENGINES].join(", ")}`);
    }
  }

  if (input.engines.includes("k6") && !input.loadProfile) {
    throw new Error("load_profile is required when engines includes k6");
  }

  if (input.apmProvider && !input.apmServiceId) {
    throw new Error("apm_service_id is required when apm_provider is set");
  }
}
