// @vitest-environment node
import { expect, it } from "vitest";
import { ApiError } from "../api/client";
import { isCockpitDefinitiveCommandRejection } from "./command-rejection";

it("keeps frozen command intent through timeouts, permission changes, throttling and unconfirmed replies", () => {
  for (const status of [401, 403, 408, 429, 500, 502, 503, 504]) {
    expect(isCockpitDefinitiveCommandRejection(new ApiError("unknown operation outcome", status, "Error"))).toBe(false);
  }
  expect(isCockpitDefinitiveCommandRejection(new Error("response not confirmed"))).toBe(false);
  for (const status of [400, 409, 410, 422]) {
    expect(isCockpitDefinitiveCommandRejection(new ApiError("command rejected", status, "Rejected"))).toBe(true);
  }
  expect(isCockpitDefinitiveCommandRejection(new ApiError("private storage required", 403, "Forbidden", { code: "private_storage_required" }))).toBe(true);
  expect(isCockpitDefinitiveCommandRejection(new ApiError("private storage required", 500, "Error", { code: "private_storage_required" }))).toBe(false);
});
