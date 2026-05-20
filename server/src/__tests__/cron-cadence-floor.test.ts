import { describe, expect, it } from "vitest";
import { minCadenceMinutes, validateCronCadenceFloor } from "../services/cron.js";

describe("minCadenceMinutes", () => {
  it("returns 1 for * * * * *", () => {
    expect(minCadenceMinutes("* * * * *")).toBe(1);
  });

  it("returns 5 for */5 * * * *", () => {
    expect(minCadenceMinutes("*/5 * * * *")).toBe(5);
  });

  it("returns 15 for */15 * * * *", () => {
    expect(minCadenceMinutes("*/15 * * * *")).toBe(15);
  });

  it("returns 30 for */30 * * * *", () => {
    expect(minCadenceMinutes("*/30 * * * *")).toBe(30);
  });

  it("returns 60 for hourly (0 * * * *)", () => {
    expect(minCadenceMinutes("0 * * * *")).toBe(60);
  });

  it("returns 60 for clustered hours (0 9,10,11 * * 1-5)", () => {
    expect(minCadenceMinutes("0 9,10,11 * * 1-5")).toBe(60);
  });

  it("returns 720 (12h) for 0 0,12 * * *", () => {
    expect(minCadenceMinutes("0 0,12 * * *")).toBe(720);
  });

  it("returns 1440 (daily) for 0 0 * * *", () => {
    expect(minCadenceMinutes("0 0 * * *")).toBe(1440);
  });

  it("returns the smallest interval across a mixed pattern", () => {
    // Fires every 5 min during 9-17 on weekdays. Smallest delta = 5 min.
    expect(minCadenceMinutes("*/5 9-17 * * 1-5")).toBe(5);
  });
});

describe("validateCronCadenceFloor", () => {
  it("returns null when cadence equals the floor", () => {
    expect(validateCronCadenceFloor("*/15 * * * *", 15)).toBeNull();
  });

  it("returns null when cadence exceeds the floor", () => {
    expect(validateCronCadenceFloor("*/30 * * * *", 15)).toBeNull();
  });

  it("returns an error string when cadence is below the floor", () => {
    const err = validateCronCadenceFloor("*/5 * * * *", 15);
    expect(err).not.toBeNull();
    expect(err).toMatch(/5m/);
    expect(err).toMatch(/15m/);
  });

  it("returns an error for every-minute schedules at default 15m floor", () => {
    expect(validateCronCadenceFloor("* * * * *", 15)).not.toBeNull();
  });

  it("returns null when floor is 0 (check disabled)", () => {
    expect(validateCronCadenceFloor("* * * * *", 0)).toBeNull();
  });

  it("returns null when floor is negative", () => {
    expect(validateCronCadenceFloor("* * * * *", -1)).toBeNull();
  });

  it("includes the actionable hint pointing at alternatives", () => {
    const err = validateCronCadenceFloor("*/2 * * * *", 15);
    expect(err).toMatch(/long-running service|webhook/);
  });
});
