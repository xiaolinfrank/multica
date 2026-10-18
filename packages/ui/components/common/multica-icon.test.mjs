import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
// eslint-disable-next-line import-x/no-extraneous-dependencies -- UI devDependency, used only by this Node test.
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("shared BayClaw branding carries original light and dark PNGs without a web asset path", async () => {
  const temporary = await mkdtemp(fileURLToPath(new URL("./.brand-test-", import.meta.url)));
  try {
    const output = join(temporary, "brand.mjs");
    // Keep React external so SSR and the component share one hook dispatcher.
    buildSync({ entryPoints: [fileURLToPath(new URL("./bayclaw-brand.tsx", import.meta.url))], outfile: output, bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"] });
    const { BayClawBrand } = await import(pathToFileURL(output).href);
    const html = renderToStaticMarkup(createElement(BayClawBrand));
    assert.match(html, /title="BayClaw"/);
    assert.match(html, /<span>BayClaw<\/span>/);
    assert.doesNotMatch(html, /clip-path|\/brand\//);
    const embedded = [...html.matchAll(/<img[^>]+src="data:image\/png;base64,([^"]+)"[^>]+>/g)];
    assert.equal(embedded.length, 2);
    for (const [index, kind] of ["light", "dark"].entries()) {
      const original = await readFile(new URL(`../../../../apps/web/public/brand/xingduo-mark-${kind}.png`, import.meta.url));
      assert.deepEqual(Buffer.from(embedded[index][1], "base64"), original);
      assert.match(embedded[index][0], /width="846" height="838"/);
      assert.match(embedded[index][0], /object-contain/);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
