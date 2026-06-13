import { describe, it, expect } from "vitest";
import { can, authorize, UnauthorizedError } from "./authorize";

describe("RBAC can()", () => {
  it("owner has tenant management", () => {
    expect(can(["owner"], "tenant:manage")).toBe(true);
  });
  it("staff cannot manage billing", () => {
    expect(can(["staff"], "billing:manage")).toBe(false);
  });
  it("super_admin can approve tenants", () => {
    expect(can(["super_admin"], "platform:approve_tenant")).toBe(true);
  });
  it("a tenant role cannot use platform permissions", () => {
    expect(can(["owner"], "platform:approve_tenant")).toBe(false);
  });
  it("authorize throws UnauthorizedError when permission is missing", () => {
    expect(() => authorize(["staff"], "billing:manage")).toThrow(UnauthorizedError);
  });
});
