import { describe, expect, it } from "vitest";
import { estimateMinCadenceMinutes } from "./ScheduleEditor";

describe("estimateMinCadenceMinutes", () => {
  it("returns 1 for every-minute schedules", () => {
    expect(estimateMinCadenceMinutes("* * * * *")).toBe(1);
  });

  it("returns the step value for */N minute schedules", () => {
    expect(estimateMinCadenceMinutes("*/5 * * * *")).toBe(5);
    expect(estimateMinCadenceMinutes("*/15 * * * *")).toBe(15);
    expect(estimateMinCadenceMinutes("*/30 * * * *")).toBe(30);
  });

  it("returns 60 for once-per-hour schedules", () => {
    expect(estimateMinCadenceMinutes("0 * * * *")).toBe(60);
    expect(estimateMinCadenceMinutes("17 * * * *")).toBe(60);
  });

  it("returns hour-step * 60 when minute is fixed and hour is */N", () => {
    expect(estimateMinCadenceMinutes("0 */2 * * *")).toBe(120);
    expect(estimateMinCadenceMinutes("30 */6 * * *")).toBe(360);
  });

  it("returns null for complex expressions it cannot reason about", () => {
    expect(estimateMinCadenceMinutes("0 9,10,11 * * 1-5")).toBeNull();
    expect(estimateMinCadenceMinutes("0 0 1 1 *")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(estimateMinCadenceMinutes("")).toBeNull();
    expect(estimateMinCadenceMinutes("not a cron")).toBeNull();
    expect(estimateMinCadenceMinutes("* * *")).toBeNull();
  });

  it("flags */1 as 1 minute (should be rejected by floor)", () => {
    expect(estimateMinCadenceMinutes("*/1 * * * *")).toBe(1);
  });
});
