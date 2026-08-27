// The office renders several i18n keys from computed strings (zone ids,
// monologue variants). i18next's strictly-typed TFunction rejects dynamic
// keys, so components accept this structural type instead and OfficePage
// adapts its real `t` once, in one place. Key shape is pinned by
// packages/core/office/monologue-key.test.ts against the locale bundles.
export type OfficeTranslate = (
  key: string,
  params?: Record<string, unknown>,
) => string;
