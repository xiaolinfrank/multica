import {
  preprocessLinks,
  preprocessMentionShortcodes,
  preprocessFileCards,
  preprocessIssueIdentifiers,
  preprocessLocalPaths,
} from "@multica/ui/markdown";
import { stripChannelMediaMarkers } from "@multica/core/types";

/**
 * Preprocess a markdown string before loading into Tiptap via contentType: 'markdown'.
 *
 * This is the ONLY transform applied before @tiptap/markdown parses the content.
 * It does NOT convert to HTML — that was the old markdownToHtml.ts pipeline which
 * was deleted in the April 2026 refactor.
 *
 * String→string transforms on raw Markdown:
 * 1. Legacy mention shortcodes [@ id="..." label="..."] → [@Label](mention://member/id)
 *    (old serialization format in database, migrated on read)
 * 2. (readonly only) Bare issue identifiers MUL-123 → [MUL-123](mention://issue/MUL-123)
 * 3. (readonly only) Bare mount-rooted paths /Volumes/… → [path](localpath://…)
 * 4. Raw URLs → markdown links via linkify-it (so they render as clickable Link nodes)
 * 5. File card syntax (new !file[name](url) + legacy [name](cdnUrl)) → HTML div for
 *    fileCard node parsing
 *
 * Shared by the Tiptap editor and the read-only react-markdown renderer so both
 * linkify identically. `autolinkIssueIdentifiers` and `autolinkLocalPaths` are
 * the deliberate asymmetries: both are OPT-IN and MUST stay off for the
 * editable Tiptap path, because each rewrites plain text into a link the author
 * never typed, which Tiptap would then serialize back into the stored markdown.
 * For identifiers the corruption is a mention node holding an identifier string
 * where a UUID belongs; for paths it is a `localpath://` href appearing in
 * content the author will later read as source. Only the readonly renderer,
 * which resolves both at render time, passes them.
 *
 * `cdnDomain` is an explicit parameter rather than an imperative
 * `configStore.getState()` read inside this function. The CDN config arrives
 * asynchronously after auth, so a one-shot read made this transform silently
 * time-dependent: content rendered before the config landed kept its legacy CDN
 * links as plain anchors forever, because nothing re-ran the transform. Passing
 * the value in lets a reactive caller (RichContent, which subscribes to the
 * store) put it in its memo dependencies, while a one-shot caller (the Tiptap
 * editor, which preprocesses once at load) can still read the store itself.
 */
export function preprocessMarkdown(
  markdown: string,
  opts: {
    cdnDomain: string;
    autolinkIssueIdentifiers?: boolean;
    autolinkLocalPaths?: boolean;
  },
): string {
  if (!markdown) return "";
  const { cdnDomain } = opts;
  // Channel-media provenance is persisted for optimistic merge safety, not
  // authored content. Remove only this namespaced comment before either the
  // editable Tiptap parser or readonly renderer sees it; the ContentEditor
  // separately retains the raw controlled value as its server merge base.
  const visibleMarkdown = stripChannelMediaMarkers(markdown);
  const step1 = preprocessMentionShortcodes(visibleMarkdown);
  const step2 = opts?.autolinkIssueIdentifiers
    ? preprocessIssueIdentifiers(step1)
    : step1;
  // Before preprocessLinks: its own file-path detector would otherwise claim
  // `/Volumes/share/report.md` as a site-relative link that navigates nowhere.
  const step3 = opts?.autolinkLocalPaths ? preprocessLocalPaths(step2) : step2;
  const step4 = preprocessLinks(step3);
  const step5 = preprocessFileCards(step4, cdnDomain);
  return step5;
}
