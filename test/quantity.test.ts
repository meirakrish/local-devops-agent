import { describe, expect, it } from "vitest";
import { formatCpu, formatMemory, parseQuantity } from "../src/scan/quantity.js";
import { podRequests } from "../src/scan/summarize.js";

describe("parseQuantity", () => {
  it("parses CPU and memory quantities", () => {
    expect(parseQuantity("64")).toBe(64);
    expect(parseQuantity("500m")).toBe(0.5);
    expect(parseQuantity("1.5")).toBe(1.5);
    expect(parseQuantity("16Mi")).toBe(16 * 2 ** 20);
    expect(parseQuantity("16246788Ki")).toBe(16246788 * 1024);
    expect(parseQuantity("1G")).toBe(1e9);
    expect(parseQuantity("1e3")).toBe(1000);
  });

  it("returns undefined instead of guessing", () => {
    expect(parseQuantity(undefined)).toBeUndefined();
    expect(parseQuantity("lots")).toBeUndefined();
    expect(parseQuantity("5 Gi")).toBeUndefined();
  });

  it("formats for humans", () => {
    expect(formatCpu(0.25)).toBe("250m");
    expect(formatCpu(64)).toBe("64");
    expect(formatMemory(32 * 2 ** 20)).toBe("32Mi");
    expect(formatMemory(15.5 * 2 ** 30)).toBe("15.5Gi");
  });
});

describe("podRequests", () => {
  const c = (cpu?: string, memory?: string) => ({
    name: "c",
    resources: { requests: { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) } },
  });

  it("sums app containers and takes the larger of that and the biggest init container", () => {
    expect(podRequests([c("500m", "64Mi"), c("1", "64Mi")])).toEqual({ cpu: 1.5, memory: 128 * 2 ** 20 });
    expect(podRequests([c("500m")], [c("2")])).toEqual({ cpu: 2, memory: undefined });
  });

  it("is undefined when nothing is requested", () => {
    expect(podRequests([{ name: "c" }])).toEqual({ cpu: undefined, memory: undefined });
  });
});
