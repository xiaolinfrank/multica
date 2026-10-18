// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";
import robots from "./robots";
import sitemap from "./sitemap";

const asset = (path: string) => readFileSync(new URL(`../public/${path}`, import.meta.url));

describe("BayClaw self-hosted product branding", () => {
  it("declares the real original PNG dimensions without claiming a maskable safe zone", () => {
    const installed = manifest();
    expect(installed.name).toBe("BayClaw");
    expect(installed.short_name).toBe("BayClaw");
    expect(installed.description).toBe("由星舵个人分身统筹的项目与任务执行工作台。");
    expect(installed.icons?.some((icon) => icon.src === "/brand/xingduo-app-icon.svg")).toBe(true);
    for (const icon of installed.icons ?? []) {
      expect(icon.purpose).toBe("any");
      if (icon.type === "image/svg+xml") {
        const wrapper = asset(icon.src.replace(/^\//, "")).toString();
        expect(icon.sizes).toBe("any");
        expect(wrapper).toContain('viewBox="0 0 846 846"');
        expect(wrapper).toContain('preserveAspectRatio="xMidYMid meet"');
        const embedded = wrapper.match(/href="data:image\/png;base64,([^"]+)"/);
        expect(embedded).not.toBeNull();
        expect(Buffer.from(embedded![1]!, "base64")).toEqual(asset("brand/xingduo-mark-light.png"));
        continue;
      }
      const png = asset(icon.src.replace(/^\//, ""));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(icon.sizes).toBe(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
      expect(icon.type).toBe("image/png");
      expect(icon.purpose).toBe("any");
    }
  });

  it("keeps the favicon wrapper's embedded image bytes identical to the original PNGs", () => {
    const wrapper = asset("favicon.svg").toString();
    expect(wrapper).toContain("<title>BayClaw</title>");
    const embedded = [...wrapper.matchAll(/href="data:image\/png;base64,([^"]+)"/g)];
    expect(embedded).toHaveLength(2);
    for (const [index, kind] of ["light", "dark"].entries()) {
      expect(Buffer.from(embedded[index]![1]!, "base64")).toEqual(asset(`brand/xingduo-mark-${kind}.png`));
    }
  });

  it("does not send self-hosted metadata to the upstream marketing origin", () => {
    const root = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
    const landing = readFileSync(new URL("./(landing)/page.tsx", import.meta.url), "utf8");
    for (const source of [root, landing]) {
      expect(source).not.toMatch(/multica\.ai|metadataBase:|canonical:|复星医药|虚拟员工|云端共享/);
    }
    expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    expect(sitemap()).toEqual([]);
    expect(root).toContain('/brand/xingduo-mark-light.png');
    expect(root).toContain('/brand/xingduo-mark-dark.png');
  });
});
