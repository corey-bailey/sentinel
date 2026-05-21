import { describe, it, expect } from "vitest";
import { validateTestPlan, type TestPlanInput } from "../validators/test-plan.js";

const validBase: TestPlanInput = {
  name: "Checkout flow tests",
  engines: ["k6"],
  loadProfile: {
    vus: 10,
    stages: [{ duration: "30s", target: 10 }],
  },
};

describe("validateTestPlan", () => {
  it("requires load_profile when engines includes k6", () => {
    const input: TestPlanInput = { ...validBase, loadProfile: undefined };
    expect(() => validateTestPlan(input)).toThrow(/load_profile.*required.*k6/i);
  });

  it("does not require load_profile for functional-only plans", () => {
    const input: TestPlanInput = { name: "API tests", engines: ["playwright"], loadProfile: undefined };
    expect(() => validateTestPlan(input)).not.toThrow();
  });

  it("rejects empty engines array", () => {
    const input: TestPlanInput = { ...validBase, engines: [] };
    expect(() => validateTestPlan(input)).toThrow(/engines.*required/i);
  });

  it("rejects unknown engine values", () => {
    const input: TestPlanInput = { ...validBase, engines: ["k6", "unknownEngine" as never] };
    expect(() => validateTestPlan(input)).toThrow(/unknown.*engine|invalid.*engine/i);
  });

  it("requires apm_service_id when apm_provider is set", () => {
    const input: TestPlanInput = { ...validBase, apmProvider: "dynatrace" };
    expect(() => validateTestPlan(input)).toThrow(/apm_service_id.*required/i);
  });

  it("accepts valid apm config with apm_service_id", () => {
    const input: TestPlanInput = { ...validBase, apmProvider: "dynatrace", apmServiceId: "svc-123" };
    expect(() => validateTestPlan(input)).not.toThrow();
  });

  it("accepts valid combined plan with all four engines", () => {
    const input: TestPlanInput = {
      name: "Full test suite",
      engines: ["k6", "playwright", "pytest", "mocha"],
      loadProfile: {
        vus: 50,
        stages: [{ duration: "60s", target: 50 }],
      },
    };
    expect(() => validateTestPlan(input)).not.toThrow();
  });

  it("accepts functional-only plan with multiple engines", () => {
    const input: TestPlanInput = {
      name: "Functional suite",
      engines: ["playwright", "pytest"],
      loadProfile: undefined,
    };
    expect(() => validateTestPlan(input)).not.toThrow();
  });

  it("requires plan name", () => {
    const input: TestPlanInput = { ...validBase, name: "" };
    expect(() => validateTestPlan(input)).toThrow(/name.*required/i);
  });
});
