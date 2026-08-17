package service

import "testing"

func TestStripMentionLinks(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "member mention collapses to @label",
			in:   "hi [@黄沛霖](mention://member/2cdcd7b8-7128-44f3-a91b-3a48a1f99300) 看一下",
			want: "hi @黄沛霖 看一下",
		},
		{
			name: "agent mention collapses to @label",
			in:   "[@Nova](mention://agent/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) please review",
			want: "@Nova please review",
		},
		{
			name: "issue mention keeps bare label without @",
			in:   "see [MUL-123](mention://issue/44c266e7-f6dd-4be3-9140-5ac40233f79c) for context",
			want: "see MUL-123 for context",
		},
		{
			name: "squad mention collapses to @label",
			in:   "handing to [@Core Squad](mention://squad/44444444-4444-4444-4444-444444444444)",
			want: "handing to @Core Squad",
		},
		{
			name: "multiple mentions in one string",
			in:   "[@A](mention://agent/11111111-1111-1111-1111-111111111111) cc [@Bob](mention://member/22222222-2222-2222-2222-222222222222)",
			want: "@A cc @Bob",
		},
		{
			name: "no mention leaves text untouched",
			in:   "plain text without any mention link",
			want: "plain text without any mention link",
		},
		{
			name: "brackets inside label are preserved",
			in:   "[@David[TF]](mention://agent/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) hi",
			want: "@David[TF] hi",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := stripMentionLinks(c.in)
			if got != c.want {
				t.Errorf("stripMentionLinks(%q) = %q; want %q", c.in, got, c.want)
			}
		})
	}
}
