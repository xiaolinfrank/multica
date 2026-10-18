// Package workspacecontext owns versioned defaults for new workspaces.
package workspacecontext

import (
	_ "embed"
	"strings"
)

// V1 is frozen alongside migration 9158. Introduce a new version for future
// defaults; existing non-empty workspace context remains owned by its user.
//
//go:embed collaboration-v1.md
var V1 string

// ForCreate fills an omitted or blank context without changing user content.
func ForCreate(value *string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return V1
	}
	return *value
}
