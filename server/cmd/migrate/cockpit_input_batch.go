package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Every step is guarded before its first destructive statement, including a
// partial concurrent-index batch. A cleanup tombstone is retained authority.
var cockpitInputMigrationVersions = []string{
	"9105_cockpit_inputs",
	"9106_cockpit_input_id_idx",
	"9107_cockpit_input_creation_idx",
	"9108_cockpit_input_page_idx",
	"9109_cockpit_input_project_page_idx",
	"9110_cockpit_input_title_idx",
	"9111_cockpit_input_principal_page_idx",
	"9112_cockpit_input_version_id_idx",
	"9113_cockpit_input_version_number_idx",
	"9114_cockpit_input_version_submission_idx",
	"9115_cockpit_input_version_verify_due_idx",
	"9116_cockpit_input_version_verify_lease_idx",
	"9117_cockpit_input_version_artifact_source_idx",
	"9118_cockpit_input_transfer_id_idx",
	"9119_cockpit_input_transfer_number_idx",
	"9120_cockpit_input_transfer_command_idx",
	"9121_cockpit_input_transfer_owned_key_idx",
	"9122_cockpit_input_transfer_active_idx",
	"9123_cockpit_input_transfer_due_idx",
	"9124_cockpit_input_transfer_lease_idx",
	"9125_cockpit_input_transfer_cleanup_idx",
	"9126_cockpit_input_reference_id_idx",
	"9127_cockpit_input_reference_creation_idx",
	"9128_cockpit_input_reference_active_idx",
	"9129_cockpit_input_reference_meeting_idx",
	"9130_cockpit_input_reference_agenda_idx",
	"9131_cockpit_input_reference_version_idx",
	"9132_cockpit_input_manifest_head_idx",
	"9133_cockpit_input_manifest_version_id_idx",
	"9134_cockpit_input_manifest_version_number_idx",
	"9135_cockpit_input_manifest_version_command_idx",
	"9136_cockpit_input_manifest_item_position_idx",
	"9137_cockpit_input_manifest_item_version_idx",
	"9138_cockpit_input_manifest_item_reverse_idx",
	"9139_cockpit_input_task_manifest_idx",
	"9140_cockpit_input_artifact_manifest_idx",
	"9141_cockpit_input_integrity",
	"9142_cockpit_input_reference_removal_idx",
}
var cockpitInputTables = []string{
	"cockpit_input", "cockpit_input_version", "cockpit_input_transfer", "cockpit_input_reference",
	"cockpit_issue_input_manifest", "cockpit_issue_input_manifest_version", "cockpit_issue_input_manifest_item",
}

func ensureCockpitInputRollbackSafe(ctx context.Context, pool *pgxpool.Pool) error {
	for _, table := range cockpitInputTables {
		var relation *string
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1)::text", table).Scan(&relation); err != nil {
			return err
		}
		if relation == nil {
			continue
		}
		var retained bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+pgx.Identifier{table}.Sanitize()+" LIMIT 1)").Scan(&retained); err != nil {
			return err
		}
		if retained {
			return fmt.Errorf("cannot roll back fixed inputs while %s retains input facts, command receipts, or stored-object cleanup responsibility", table)
		}
	}
	for _, table := range []string{"agent_task_queue", "cockpit_artifact_version"} {
		var column bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name='input_manifest_version_id')", table).Scan(&column); err != nil {
			return err
		}
		if !column {
			continue
		}
		var retained bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+pgx.Identifier{table}.Sanitize()+" WHERE input_manifest_version_id IS NOT NULL LIMIT 1)").Scan(&retained); err != nil {
			return err
		}
		if retained {
			return fmt.Errorf("cannot roll back fixed inputs while %s retains an original manifest pin", table)
		}
	}
	return nil
}
