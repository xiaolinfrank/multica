/**
 * Local filesystem path detection for markdown preprocessing.
 *
 * Agents report where they put a deliverable by writing the path as plain
 * text ("写入 /Volumes/协作空间/项目/模块/报告.pdf"). Nothing in that sentence
 * marks it as a path, and asking agents to emit a special syntax instead would
 * put the burden on every model in the fleet and break the moment one of them
 * forgets. So detection happens here, on the reader's side: the renderer finds
 * the path in the prose and turns it into an affordance that opens the folder.
 *
 * Scope is deliberately narrow — only paths rooted at a place that is, by
 * convention, a mounted volume rather than a machine-local directory:
 *
 *   - `/Volumes/…`            macOS mounts every external and network volume here
 *   - `/mnt/…`, `/media/…`    the Linux equivalents
 *   - `\\host\share\…`        Windows UNC
 *   - `Z:\…` / `Z:/…`         a Windows drive letter, which is how a mapped share appears
 *
 * A bare `/etc/hosts` or `/usr/local/bin` stays plain text. Those are paths on
 * whichever machine wrote the sentence, so an "open" button next to one would
 * point at something the reader does not have; the mount roots above are the
 * shapes that mean "somewhere both of us can reach".
 *
 * Paths are delimited by whitespace, which is the one rule prose can enforce:
 * a directory name containing a space cannot be told apart from the sentence
 * around it, so such a path links only up to the space. The project property
 * renders its stored value verbatim and is unaffected.
 */

import {
  findCodeRanges,
  findMarkdownLinkRanges,
  isInsideCode,
  rangesOverlap,
} from './linkify'

/** URL scheme carrying a detected path to the renderer. Must be listed in
 *  `markdownSanitizeSchema.protocols.href` and passed through
 *  `markdownUrlTransform`, or the sanitizer drops the href. */
export const LOCAL_PATH_PROTOCOL = 'localpath'

const HREF_PREFIX = `${LOCAL_PATH_PROTOCOL}://`

/** Mount roots, as an alternation reused by both the scanner and the cheap
 *  pre-test. Written as source text rather than a RegExp so the two cannot
 *  drift. */
const MOUNT_ROOT_SOURCE = [
  String.raw`\/(?:Volumes|mnt|media)\/`,
  String.raw`\\\\[^\s\\\/]+\\`,
  String.raw`[A-Za-z]:[\\\/]`,
].join('|')

/** Cheap early-out so the common case (no path anywhere) costs one scan. */
const HAS_MOUNT_ROOT = new RegExp(MOUNT_ROOT_SOURCE)

/**
 * Characters a path may run through, as an exclusion set.
 *
 * Three groups are out. Characters no Windows path may hold and that would
 * break the generated markdown link: quotes, angle brackets, backtick, pipe,
 * the glob characters, square brackets (a `]` closes the link label) and the
 * colon. And CJK sentence punctuation, which ends the path the way whitespace
 * does in English — Chinese prose puts no space after a comma, so without this
 * the rest of the sentence is swallowed into the path.
 *
 * Full-width parentheses and brackets deliberately stay IN. Real directories
 * on the share are named like `01.01回顾性队列数据集（JIA）`, so treating
 * `）` as a terminator would truncate the path at its most distinctive
 * segment. A `）` that really is the end of a parenthetical is handled
 * instead by the balance-aware trim below, which can tell the two apart.
 */
const PATH_RUN =
  `[^\\s<>"'\`|*?\\[\\]:\u3000\u3001\u3002\u2026\u300c\u300d\u300e\u300f\uff01\uff0c\uff1a\uff1b\uff1f]+`

/**
 * A mount root followed by a run of path characters.
 *
 * The lookbehind rejects a preceding character that would make this the middle
 * of a longer token rather than the start of a path: a word character, another
 * separator, or the punctuation that glues a URL together. That is what keeps
 * `https://example.com/Volumes/x` and `~/Volumes/x` out while letting through
 * every way prose actually introduces a path — after a space, a bracket, a
 * markdown delimiter, or a colon with no space after it — the last of which is
 * how a Chinese sentence introduces one, since full-width punctuation carries
 * its own spacing. An allow-list of opening characters cannot cover that
 * without enumerating punctuation in two writing systems.
 *
 * The run itself is defined by PATH_RUN below.
 */
const LOCAL_PATH_RE = new RegExp(
  `(?<![\\w/\\\\.\\-~%@])((${MOUNT_ROOT_SOURCE})${PATH_RUN})`,
  'g'
)

/**
 * ASCII punctuation that ends the sentence rather than the path. CJK
 * punctuation is absent because PATH_RUN already stops before it, and
 * parentheses are absent because they need the balance check below.
 *
 * `/` is deliberately absent too: a trailing slash is how a writer marks the
 * value as a directory, and keeping it preserves that intent. `.` is trimmed
 * even though a filename contains dots, because a trailing dot is always the
 * end of a sentence — an extension never ends with one.
 */
const TRAILING_PUNCTUATION = /[.,;!?}]+$/

/** True when `path` closes a bracket it never opened, which means the closer
 *  belongs to the sentence ("(/Volumes/share/x)") rather than to a directory
 *  name ("…/数据集（JIA）"). */
function closesUnopened(path: string, open: string, close: string): boolean {
  let depth = 0
  for (const char of path) {
    if (char === open) depth += 1
    else if (char === close) depth -= 1
  }
  return depth < 0
}

/**
 * Strip the punctuation that belongs to the prose, one character at a time.
 *
 * A loop rather than one regex because the two rules interleave: `(/Volumes/x).`
 * needs the dot dropped before the paren is even the last character, and
 * `…（JIA）。` needs the paren KEPT after it becomes one.
 */
function trimSentenceTail(raw: string): string {
  let path = raw
  for (;;) {
    const trimmed = path.replace(TRAILING_PUNCTUATION, '')
    if (trimmed !== path) {
      path = trimmed
      continue
    }
    const last = path[path.length - 1]
    if (last === ')' && closesUnopened(path, '(', ')')) {
      path = path.slice(0, -1)
      continue
    }
    if (last === '\uff09' && closesUnopened(path, '\uff08', '\uff09')) {
      path = path.slice(0, -1)
      continue
    }
    return path
  }
}

/** True when the text might contain a path worth scanning for. */
export function hasLocalPath(text: string): boolean {
  return HAS_MOUNT_ROOT.test(text)
}

/** Build the href a detected path travels on. Exported for tests and for the
 *  surfaces that render a stored path (a project's collaboration space) through
 *  the same component without going through markdown. */
export function localPathHref(path: string): string {
  return `${HREF_PREFIX}${encodeURIComponent(path)}`
}

/** The path a `localpath://` href carries, or `null` for any other href.
 *  Returns `null` rather than throwing on a malformed escape, so a corrupted
 *  href degrades to a plain link instead of crashing the renderer. */
export function localPathFromHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith(HREF_PREFIX)) return null
  const encoded = href.slice(HREF_PREFIX.length)
  if (!encoded) return null
  try {
    const path = decodeURIComponent(encoded)
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

/**
 * Rewrite bare mount-rooted paths into markdown links carrying the
 * `localpath://` scheme.
 *
 * Runs BEFORE `preprocessLinks`: that pass has its own file-path detector
 * (extension-based, ASCII-only) which would otherwise turn
 * `/Volumes/share/report.md` into a site-relative link that navigates nowhere.
 * Emitting the markdown link first puts the span inside
 * `findMarkdownLinkRanges`, so the later pass leaves it alone.
 *
 * READ-ONLY SURFACES ONLY. Like `preprocessIssueIdentifiers`, this must never
 * run on the editable Tiptap path: the rewritten link would be serialized back
 * into the saved markdown and the stored content would grow a scheme the author
 * never typed.
 */
export function preprocessLocalPaths(text: string): string {
  if (!text || !HAS_MOUNT_ROOT.test(text)) return text

  const codeRanges = findCodeRanges(text)
  const linkRanges = findMarkdownLinkRanges(text)

  LOCAL_PATH_RE.lastIndex = 0
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = LOCAL_PATH_RE.exec(text)) !== null) {
    const raw = match[1]
    const root = match[2]
    if (!raw || !root) continue

    const start = match.index
    const path = trimSentenceTail(raw)
    // Nothing but the mount root survived the trim ("see /Volumes/."), so there
    // is no directory being named here.
    if (path.length <= root.length) continue
    const end = start + path.length
    const range = { start, end }

    if (isInsideCode(start, codeRanges)) continue
    if (linkRanges.some((r) => rangesOverlap(range, r))) continue

    result += text.slice(lastIndex, start)
    result += `[${path}](${localPathHref(path)})`
    lastIndex = end
  }

  if (lastIndex === 0) return text
  result += text.slice(lastIndex)
  return result
}
