// @vitest-environment node
import { describe, expect, it } from "vitest";
import sitemap from "./sitemap";

describe("sitemap.xml", () => {
  it("lists nothing: the self-hosted instance has no public marketing site", () => {
    // Every route behind this deployment needs a session, and the marketing
    // origin belongs to upstream — advertising either would be wrong.
    expect(sitemap()).toEqual([]);
  });
});
