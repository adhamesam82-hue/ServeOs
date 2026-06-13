import { describe, it, expect } from "vitest";
import { assertSuperAdmin } from "./require-role";

describe("assertSuperAdmin", () => {
  it("passes for super_admin", () => {
    expect(() => assertSuperAdmin(["super_admin"])).not.toThrow();
  });
  it("throws for tenant roles", () => {
    expect(() => assertSuperAdmin(["owner"])).toThrow(/forbidden/i);
  });
  it("throws for an empty role list", () => {
    expect(() => assertSuperAdmin([])).toThrow(/forbidden/i);
  });
});
