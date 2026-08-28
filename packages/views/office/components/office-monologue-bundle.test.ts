// @vitest-environment node
// Pins MONOLOGUE_VARIANTS (packages/core/office/zones.ts) against every
// locale bundle: the core comment says the bundle "must carry at least this
// many lines for each" kind, but nothing asserted it — a variant bump
// without new copy rendered raw i18n keys above the agents' heads.
import { describe, expect, it } from "vitest";
import { MONOLOGUE_VARIANTS, RELAX_ZONES } from "@multica/core/office";
import { RESOURCES } from "../../locales";

type Json = Record<string, unknown>;

function at(bundle: Json, path: string): unknown {
  let node: unknown = bundle;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Json)[key];
  }
  return node;
}

describe("office monologue bundle coverage", () => {
  const locales = Object.keys(RESOURCES) as Array<keyof typeof RESOURCES>;

  for (const locale of locales) {
    it(`carries every monologue variant in ${locale}`, () => {
      const office = RESOURCES[locale].office as Json;
      for (const [kind, count] of Object.entries(MONOLOGUE_VARIANTS)) {
        if (kind === "idle") {
          for (const zone of RELAX_ZONES) {
            for (let v = 0; v < count; v++) {
              expect(at(office, `monologue.idle.${zone}.${v}`), `${locale} monologue.idle.${zone}.${v}`).toBeTypeOf("string");
            }
          }
          continue;
        }
        for (let v = 0; v < count; v++) {
          expect(at(office, `monologue.${kind}.${v}`), `${locale} monologue.${kind}.${v}`).toBeTypeOf("string");
        }
      }
    });
  }
});
