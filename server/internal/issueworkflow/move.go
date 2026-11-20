package issueworkflow

// Cross-project status mapping, shared by the two paths that move an issue into
// another project: a write through the issue detail (applyIssueWorkflow) and a
// plan edit that moves the work item the issue is filed under (S3). Keeping one
// function is what stops the two entry points from producing different statuses
// for the same move.
//
// A move into a project on the Default workflow keeps the status: Default
// accepts everything and never maps. A named workflow that lists the status
// keeps it too. Only a named workflow that does NOT list it maps — to the step
// of the same lifecycle category, else to the workflow's start status.

// MappedStatusForMove is the status an issue carries after moving into a
// project. ok=false means "keep the current status".
func MappedStatusForMove(def *Definition, status string, categoryOf func(string) string) (string, bool) {
	if def == nil || def.IsDefault || def.Has(status) {
		return "", false
	}
	return MoveTarget(*def, status, categoryOf), true
}
