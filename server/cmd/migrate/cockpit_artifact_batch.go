package main

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Guard every step, including a partially applied batch, before dropping indexes.
var cockpitArtifactMigrationVersions = []string{
	"9000_cockpit_artifact",
	"9001_cockpit_artifact_id_idx",
	"9002_cockpit_artifact_creation_key_idx",
	"9003_cockpit_artifact_owner_idx",
	"9004_cockpit_artifact_source_issue_idx",
	"9005_cockpit_artifact_producer_issue_idx",
	"9006_cockpit_artifact_version",
	"9007_cockpit_artifact_version_id_idx",
	"9008_cockpit_artifact_version_number_idx",
	"9009_cockpit_artifact_version_submission_idx",
	"9010_cockpit_artifact_version_review_idx",
	"9011_cockpit_artifact_version_producer_idx",
	"9012_cockpit_artifact_version_meeting_idx",
	"9013_cockpit_artifact_capture",
	"9014_cockpit_artifact_capture_version_idx",
	"9015_cockpit_artifact_capture_due_idx",
	"9016_cockpit_artifact_capture_attempt",
	"9017_cockpit_artifact_capture_attempt_id_idx",
	"9018_cockpit_artifact_capture_attempt_number_idx",
	"9019_cockpit_artifact_capture_attempt_key_idx",
	"9020_cockpit_artifact_capture_cleanup_due_idx",
	"9021_cockpit_artifact_reviewer_handoff",
	"9022_cockpit_artifact_handoff_id_idx",
	"9023_cockpit_artifact_handoff_command_idx",
	"9024_cockpit_artifact_handoff_page_idx",
	"9025_cockpit_artifact_handoff_retired_issue_idx",
	"9026_cockpit_artifact_producer_assignment",
	"9027_cockpit_artifact_producer_assignment_id_idx",
	"9028_cockpit_artifact_producer_assignment_command_idx",
	"9029_cockpit_artifact_producer_assignment_page_idx",
	"9030_cockpit_artifact_producer_assignment_from_idx",
	"9031_cockpit_artifact_producer_assignment_to_idx",
	"9032_cockpit_artifact_node_reference",
	"9033_cockpit_artifact_node_reference_id_idx",
	"9034_cockpit_artifact_node_reference_key_idx",
	"9035_cockpit_artifact_node_reference_active_idx",
	"9036_cockpit_artifact_node_reference_target_idx",
	"9037_cockpit_artifact_node_reference_artifact_idx",
	"9038_cockpit_artifact_meeting_reference",
	"9039_cockpit_artifact_meeting_reference_id_idx",
	"9040_cockpit_artifact_meeting_reference_key_idx",
	"9041_cockpit_artifact_meeting_reference_active_idx",
	"9042_cockpit_artifact_meeting_reference_target_idx",
	"9043_cockpit_artifact_meeting_reference_artifact_idx",
	"9044_cockpit_acceptance_definition",
	"9045_cockpit_acceptance_definition_node_idx",
	"9046_cockpit_acceptance_criterion",
	"9047_cockpit_acceptance_criterion_id_idx",
	"9048_cockpit_acceptance_criterion_node_idx",
	"9049_cockpit_acceptance_request",
	"9050_cockpit_acceptance_request_id_idx",
	"9051_cockpit_acceptance_request_key_idx",
	"9052_cockpit_acceptance_request_page_idx",
	"9053_cockpit_acceptance_request_review_idx",
	"9054_cockpit_acceptance_request_criterion",
	"9055_cockpit_acceptance_request_criterion_key_idx",
	"9056_cockpit_acceptance_evidence",
	"9057_cockpit_acceptance_evidence_key_idx",
	"9058_cockpit_acceptance_evidence_version_idx",
	"9059_cockpit_acceptance_reviewer_handoff",
	"9060_cockpit_acceptance_handoff_id_idx",
	"9061_cockpit_acceptance_handoff_command_idx",
	"9062_cockpit_acceptance_handoff_page_idx",
	"9063_cockpit_acceptance_handoff_retired_issue_idx",
	"9064_cockpit_artifact_integrity",
}

var cockpitArtifactTables = []string{
	"cockpit_artifact",
	"cockpit_artifact_version",
	"cockpit_artifact_capture",
	"cockpit_artifact_capture_attempt",
	"cockpit_artifact_reviewer_handoff",
	"cockpit_artifact_producer_assignment",
	"cockpit_artifact_node_reference",
	"cockpit_artifact_meeting_reference",
	"cockpit_acceptance_definition",
	"cockpit_acceptance_criterion",
	"cockpit_acceptance_request",
	"cockpit_acceptance_request_criterion",
	"cockpit_acceptance_evidence",
	"cockpit_acceptance_reviewer_handoff",
}

func ensureCockpitArtifactRollbackSafe(ctx context.Context, pool *pgxpool.Pool) error {
	for _, table := range cockpitArtifactTables {
		var relation *string
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1)::text", table).Scan(&relation); err != nil {
			return fmt.Errorf("inspect artifact rollback table: %w", err)
		}
		if relation == nil {
			continue
		}
		var present bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+pgx.Identifier{table}.Sanitize()+" LIMIT 1)").Scan(&present); err != nil {
			return fmt.Errorf("inspect artifact rollback ownership: %w", err)
		}
		if present {
			return fmt.Errorf("cannot roll back artifacts while %s retains facts or stored-object cleanup responsibilities; use application cleanup and verify storage first", table)
		}
	}
	return nil
}
