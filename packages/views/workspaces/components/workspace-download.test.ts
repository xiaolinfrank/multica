import { describe, it, expect } from "vitest";
import { base64ToBlob } from "./workspace-download";

describe("base64ToBlob", () => {
  it("decodes base64 into a typed Blob", async () => {
    const blob = base64ToBlob(btoa("hello world"), "text/plain");
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("hello world");
  });

  it("defaults the type to octet-stream when no mime is given", () => {
    expect(base64ToBlob(btoa("x"), "").type).toBe("application/octet-stream");
  });
});
