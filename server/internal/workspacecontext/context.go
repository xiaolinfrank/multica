// Package workspacecontext owns versioned defaults for new workspaces.
package workspacecontext

import (
	_ "embed"
	"strings"
)

// V2 is frozen alongside migration 9166. Introduce a new version for future
// defaults; existing non-empty workspace context remains owned by its user.
//
//go:embed collaboration-v2.md
var V2 string

// ForCreate fills an omitted or blank context without changing user content.
func ForCreate(value *string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return V2
	}
	return *value
}
