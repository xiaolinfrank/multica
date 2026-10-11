package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var cockpitDirectoryMigrationVersions = []string{
	"9092_cockpit_meeting_directory",
	"9093_cockpit_directory_operation_id_idx",
	"9094_cockpit_directory_operation_page_idx",
	"9095_cockpit_directory_operation_target_idx",
	"9096_cockpit_directory_operation_intent_idx",
	"9097_cockpit_directory_step_id_idx",
	"9098_cockpit_directory_step_position_idx",
	"9099_cockpit_directory_step_path_idx",
	"9100_cockpit_directory_step_queue_idx",
	"9101_cockpit_directory_step_lease_idx",
	"9102_cockpit_directory_attempt_id_idx",
	"9103_cockpit_directory_attempt_page_idx",
	"9104_cockpit_directory_integrity",
}

func ensureCockpitDirectoryRollbackSafe(ctx context.Context, pool *pgxpool.Pool) error {
	for _, table := range []string{"cockpit_meeting_directory_operation", "cockpit_meeting_directory_step", "cockpit_meeting_directory_attempt"} {
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
			return fmt.Errorf("cannot roll back meeting directories while %s retains an authorization or filesystem observation", table)
		}
	}
	var column bool
	if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='cockpit_meeting_lifecycle_command' AND column_name='directory_operation_id')").Scan(&column); err != nil {
		return err
	}
	if column {
		var retained bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM cockpit_meeting_lifecycle_command WHERE directory_operation_id IS NOT NULL OR directory_step_id IS NOT NULL OR actor_type<>'member' OR kind LIKE 'directory_%')").Scan(&retained); err != nil {
			return err
		}
		if retained {
			return fmt.Errorf("cannot roll back meeting directories while their command identities or receipts remain")
		}
	}
	if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='cockpit_meeting' AND column_name='nas_dir_revision')").Scan(&column); err != nil {
		return err
	}
	if column {
		var changed bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM cockpit_meeting WHERE nas_dir_revision<>1)").Scan(&changed); err != nil {
			return err
		}
		if changed {
			return fmt.Errorf("cannot roll back meeting directories while changed binding revisions would be lost")
		}
	}
	return nil
}
