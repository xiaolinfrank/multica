// Package issuegraph extracts issue-to-issue references from markdown text.
//
// The graph endpoint needs every way one issue can point at another in stored
// prose (issue descriptions and comment bodies). Two shapes exist in the wild:
//
//   - canonical mention links, written by the editor on save:
//     [BIO-65](mention://issue/<uuid>) — the id segment is a UUID, except for
//     bare-identifier mentions where it is the PREFIX-N token itself
//   - bare identifiers (BIO-65) typed into prose. The renderer autolinks these
//     at display time (packages/ui/markdown/issue-identifiers.ts), so stored
//     text keeps them as plain tokens.
//
// The bare-identifier rules here are a port of the renderer's IDENTIFIER_RE
// pipeline: case-sensitive uppercase tokens, never inside code, existing
// markdown links, URLs, dotted filenames, or path segments. Go's RE2 has no
// look-around, so the boundary checks are done on the neighboring bytes
// instead. A candidate that fails to resolve against the workspace (wrong
// prefix or no such number) is dropped by the caller, which keeps a rare
// over-match harmless — mirroring the renderer, where an unresolved candidate
// just renders as plain text.
package issuegraph

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	// mentionIssueLinkRe matches canonical issue mentions including their
	// label: [BIO-65](mention://issue/<id>). The label must be consumed so the
	// bare-identifier pass does not re-match the PREFIX-N inside it.
	mentionIssueLinkRe = regexp.MustCompile(`\[([^\]]*)\]\(mention://issue/([^)\s]+)\)`)
	fencedCodeRe       = regexp.MustCompile("(?s)```.*?```")
	inlineCodeRe       = regexp.MustCompile("`[^`\n]*`")
	urlRe              = regexp.MustCompile(`https?://[^\s)\]]+`)
	bareIdentifierRe   = regexp.MustCompile(`[A-Z][A-Z0-9]*-[0-9]+`)
	uuidShapeRe        = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// ExtractIssueReferences returns the deduplicated set of reference targets in
// text. Each element is the raw id segment: a UUID for canonical mentions, or
// a PREFIX-N identifier for bare tokens and identifier-form mentions. The
// caller resolves identifiers against the workspace and drops targets that do
// not exist there.
func ExtractIssueReferences(text string) []string {
	if text == "" {
		return nil
	}

	seen := make(map[string]struct{})
	var refs []string
	add := func(id string) {
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		refs = append(refs, id)
	}

	// Pass 1: canonical mention links. Their id segment is used verbatim.
	for _, match := range mentionIssueLinkRe.FindAllStringSubmatch(text, -1) {
		add(match[2])
	}

	// Pass 2: bare identifiers over a masked copy of the text, where every
	// span that must never count as a reference is blanked with spaces (same
	// length, so offsets stay valid): fenced and inline code, URLs, and the
	// mention links consumed above (label included, so "BIO-65" inside
	// [BIO-65](mention://...) is not double-counted).
	masked := text
	for _, re := range []*regexp.Regexp{fencedCodeRe, inlineCodeRe, urlRe, mentionIssueLinkRe} {
		masked = re.ReplaceAllStringFunc(masked, func(s string) string {
			return strings.Repeat(" ", len(s))
		})
	}

	for _, match := range bareIdentifierRe.FindAllStringIndex(masked, -1) {
		start, end := match[0], match[1]
		if !isStandaloneToken(masked, start, end) {
			continue
		}
		add(masked[start:end])
	}

	return refs
}

// isStandaloneToken ports the look-around and context rules of the renderer's
// IDENTIFIER_RE: no alphanumerics, `_` or `-` glued to either side (the regex
// proper), and none of the dotted/path contexts that mark a filename rather
// than a reference.
func isStandaloneToken(text string, start, end int) bool {
	isWordByte := func(b byte) bool {
		return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_' || b == '-'
	}
	if start > 0 && isWordByte(text[start-1]) {
		return false
	}
	if end < len(text) && isWordByte(text[end]) {
		return false
	}
	// Dotted continuation such as `ABC-123.ts`: a '.' followed by an
	// alphanumeric extends the token into a filename. A trailing '.' before
	// whitespace/EOL is a sentence end and stays a reference.
	if end < len(text) && text[end] == '.' {
		if end+1 < len(text) {
			b := text[end+1]
			if b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' {
				return false
			}
		}
	}
	// Path segments such as `FOO-1/bar` or `foo/BAR-1`, and dotted names on
	// the left (`file.MUL-1`).
	if end < len(text) && text[end] == '/' {
		return false
	}
	if start > 0 && (text[start-1] == '/' || text[start-1] == '.') {
		return false
	}
	return true
}

// IsUUIDShape reports whether a reference id segment is a UUID (a canonical
// mention) rather than a bare identifier.
func IsUUIDShape(id string) bool {
	return uuidShapeRe.MatchString(id)
}

// ParseIdentifierNumber extracts the numeric part of a PREFIX-N identifier.
func ParseIdentifierNumber(identifier string) (int32, bool) {
	dash := strings.LastIndex(identifier, "-")
	if dash <= 0 || dash == len(identifier)-1 {
		return 0, false
	}
	n, err := strconv.ParseInt(identifier[dash+1:], 10, 32)
	if err != nil || n <= 0 {
		return 0, false
	}
	return int32(n), true
}

// MatchesWorkspacePrefix reports whether identifier's prefix segment equals
// the workspace issue prefix, case-insensitively. Identifiers are only unique
// within a workspace, so a token from another workspace (pasted prose) must
// not be resolved against this workspace's numbers — the same guard the
// search path applies (see handler.go resolveIssueByIdentifier).
func MatchesWorkspacePrefix(identifier, prefix string) bool {
	dash := strings.LastIndex(identifier, "-")
	if dash <= 0 {
		return false
	}
	return strings.EqualFold(identifier[:dash], prefix)
}
