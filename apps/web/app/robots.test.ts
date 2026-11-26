// @vitest-environment node
import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  const { rules, sitemap: sitemaps } = robots();
  const groups = Array.isArray(rules) ? rules : [rules];

  it("keeps the whole private workbench out of every crawler", () => {
    // BayClaw is a private, self-hosted workbench: there is no public
    // marketing site to welcome crawlers to.
    expect(groups).toEqual([{ userAgent: "*", disallow: "/" }]);
  });

  it("advertises no sitemap", () => {
    expect(sitemaps).toBeUndefined();
  });
});
