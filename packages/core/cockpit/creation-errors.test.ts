// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { getCockpitNodeBindingConflict } from "./creation-errors";
const key = "10000000-0000-4000-8000-000000000001", node = "20000000-0000-4000-8000-000000000001";
const body = { code: "node_binding_exists", workspace_id: "ws-1", creation_key: key, existing_node_id: node };
describe("node binding recovery receipts", () => {
  it("exposes only the verified target from the same creation command and workspace", () => {
    expect(getCockpitNodeBindingConflict(new ApiError("Already mapped", 409, "Conflict", body), "ws-1", key)).toEqual(body);
  });
  it("does not turn unknown conflicts, wrong scope or an untrusted destination into a recovery link", () => {
    for (const patch of [{ code: "other_conflict" }, { workspace_id: "other" }, { creation_key: node }, { existing_node_id: "javascript:alert(1)" }, { existing_node_id: undefined }]) {
      expect(getCockpitNodeBindingConflict(new ApiError("Conflict", 409, "Conflict", { ...body, ...patch }), "ws-1", key)).toBeNull();
    }
    expect(getCockpitNodeBindingConflict(new ApiError("Offline", 500, "Error", body), "ws-1", key)).toBeNull();
    expect(getCockpitNodeBindingConflict(new Error("Network"), "ws-1", key)).toBeNull();
  });
});
