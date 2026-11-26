import type { LocaleResources, SupportedLocale } from "@multica/core/i18n";
import en from "./en";
import es from "./es";
import fr from "./fr";
import ja from "./ja";
import ko from "./ko";
import ru from "./ru";
import zhHans from "./zh-Hans";
import zhHant from "./zh-Hant";

// Shared <locale>.ts entries are the source of truth for namespace registrations.
// Add namespaces to every language entry. When adding a language, update its
// entry module, packages/views/package.json exports, and the web LocaleBundle's
// BUNDLES registration.
export const RESOURCES: Record<SupportedLocale, LocaleResources> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ko,
  ja,
  ru,
  fr,
  es,
};
