package issuegraph

import (
	"reflect"
	"testing"
)

func TestExtractIssueReferencesCanonicalMentions(t *testing.T) {
	const uuidA = "11111111-1111-1111-1111-111111111111"
	const uuidB = "22222222-2222-2222-2222-222222222222"
	text := "Follow-up in [" + "BIO-65](mention://issue/" + uuidA + ") and [X](mention://issue/" + uuidB + ")."
	got := ExtractIssueReferences(text)
	want := []string{uuidA, uuidB}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("canonical mentions: got %v want %v", got, want)
	}
}

func TestExtractIssueReferencesIdentifierMentionForm(t *testing.T) {
	// The mention transport is reused for bare identifiers: the id segment is
	// the PREFIX-N token, not a UUID.
	got := ExtractIssueReferences("[BIO-65](mention://issue/BIO-65)")
	want := []string{"BIO-65"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("identifier mention: got %v want %v", got, want)
	}
}

func TestExtractIssueReferencesDedupesAcrossForms(t *testing.T) {
	// Same target as a mention and as a bare token later in the text counts once.
	got := ExtractIssueReferences("See [BIO-1](mention://issue/BIO-1), and BIO-1 again.")
	want := []string{"BIO-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupe: got %v want %v", got, want)
	}
}

func TestExtractIssueReferencesBareIdentifiers(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"plain", "blocked by BIO-65 for now", []string{"BIO-65"}},
		{"sentence period keeps token", "see BIO-1.", []string{"BIO-1"}},
		{"comma boundary", "BIO-1,BIO-2", []string{"BIO-1", "BIO-2"}},
		{"lowercase prefix is not a reference", "the abc-1 trick", nil},
		{"underscore glue", "x_BIO-1", nil},
		{"dash glue", "A-BIO-1", nil}, // '-' before the token keeps it glued to a larger word, same as the renderer's lookbehind
		{"dotted filename tail", "patch ABC-123.ts applied", nil},
		{"dotted archive tail", "bundle FOO-1.tar.gz ready", nil},
		{"path segment right", "dir/BIO-1/file", nil},
		{"path segment left", "see BIO-1/x for details", nil},
		{"dotted name on the left", "file.MUL-1", nil},
		{"code span", "run `BIO-9 --fix` locally", nil},
		{"fenced block", "```\nBIO-9 hidden\n```", nil},
		{"url containing token", "https://example.com/BIO-9/x", nil},
		{"url without protocol", "plain text only", nil},
		{"multiple prefixes", "BIO-1 plus FOS-42 both", []string{"BIO-1", "FOS-42"}},
		{"hyphenated prose stays out", "state-of-the-art-3", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractIssueReferences(tc.text)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestExtractIssueReferencesEmpty(t *testing.T) {
	if got := ExtractIssueReferences(""); got != nil {
		t.Fatalf("empty text: got %v want nil", got)
	}
}

func TestIsUUIDShape(t *testing.T) {
	if !IsUUIDShape("11111111-1111-1111-1111-111111111111") {
		t.Fatal("UUID should match")
	}
	if IsUUIDShape("BIO-65") {
		t.Fatal("identifier should not match")
	}
}

func TestParseIdentifierNumber(t *testing.T) {
	if n, ok := ParseIdentifierNumber("BIO-65"); !ok || n != 65 {
		t.Fatalf("BIO-65: got (%d,%v) want (65,true)", n, ok)
	}
	if _, ok := ParseIdentifierNumber("BIO-"); ok {
		t.Fatal("BIO- should not parse")
	}
	if _, ok := ParseIdentifierNumber("-5"); ok {
		t.Fatal("-5 should not parse")
	}
	if _, ok := ParseIdentifierNumber("BIO-0"); ok {
		t.Fatal("number must be positive")
	}
}

func TestMatchesWorkspacePrefix(t *testing.T) {
	if !MatchesWorkspacePrefix("BIO-65", "BIO") {
		t.Fatal("exact prefix should match")
	}
	if !MatchesWorkspacePrefix("bio-65", "BIO") {
		t.Fatal("prefix match is case-insensitive")
	}
	if MatchesWorkspacePrefix("FOS-65", "BIO") {
		t.Fatal("foreign prefix should not match")
	}
}
