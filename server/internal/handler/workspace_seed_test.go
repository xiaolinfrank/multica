package handler

import "testing"

// The daemon builds its registration batch by iterating a Go map, so batch
// order is random. The seeder must still deterministically bind preset agents
// to Claude Code whenever the batch offers it, regardless of arrival order.
func TestPreferSeedRuntime(t *testing.T) {
	tests := []struct {
		name              string
		currentProvider   string
		currentValid      bool
		candidateOnline   bool
		candidateProvider string
		want              bool
	}{
		{"empty slot takes any online runtime", "", false, true, "hermes", true},
		{"offline candidate never selected", "", false, false, "claude", false},
		{"first non-preferred runtime stays until preferred arrives", "hermes", true, true, "openclaw", false},
		{"preferred displaces non-preferred", "hermes", true, true, "claude", true},
		{"preferred displaces non-preferred even late in batch", "openclaw", true, true, "claude", true},
		{"nothing displaces preferred", "claude", true, true, "hermes", false},
		{"preferred stays over another preferred", "claude", true, true, "claude", false},
		{"offline preferred does not displace", "hermes", true, false, "claude", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := preferSeedRuntime(tt.currentProvider, tt.currentValid, tt.candidateOnline, tt.candidateProvider)
			if got != tt.want {
				t.Fatalf("preferSeedRuntime(%q, %v, %v, %q) = %v, want %v",
					tt.currentProvider, tt.currentValid, tt.candidateOnline, tt.candidateProvider, got, tt.want)
			}
		})
	}
}

// Simulate both shuffled orders of a {claude, hermes} batch: the final pick
// must be claude either way.
func TestPreferSeedRuntime_BatchOrderIndependent(t *testing.T) {
	for _, batch := range [][]string{{"claude", "hermes"}, {"hermes", "claude"}} {
		var provider string
		var valid bool
		for _, p := range batch {
			if preferSeedRuntime(provider, valid, true, p) {
				provider = p
				valid = true
			}
		}
		if provider != seedPreferredProvider {
			t.Fatalf("batch %v: picked %q, want %q", batch, provider, seedPreferredProvider)
		}
	}
}
