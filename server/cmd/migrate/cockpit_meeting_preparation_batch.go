package main

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var cockpitPreparationMigrationVersions = []string{
	"9076_cockpit_meeting_preparation",
	"9077_cockpit_template_id_idx",
	"9078_cockpit_template_page_idx",
	"9079_cockpit_template_version_id_idx",
	"9080_cockpit_template_version_number_idx",
	"9081_cockpit_template_version_command_idx",
	"9082_cockpit_preparation_operation_id_idx",
	"9083_cockpit_preparation_operation_command_idx",
	"9084_cockpit_preparation_operation_template_idx",
	"9085_cockpit_preparation_operation_page_idx",
	"9086_cockpit_preparation_effect_id_idx",
	"9087_cockpit_preparation_effect_position_idx",
	"9088_cockpit_preparation_effect_slot_idx",
	"9089_cockpit_preparation_effect_command_idx",
	"9090_cockpit_preparation_effect_issue_idx",
	"9091_cockpit_meeting_preparation_integrity",
}

func ensureCockpitPreparationRollbackSafe(ctx context.Context, pool *pgxpool.Pool) error {
	for _, table := range []string{"cockpit_meeting_template", "cockpit_meeting_template_version", "cockpit_meeting_preparation_operation", "cockpit_meeting_preparation_effect"} {
		var relation *string
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1)::text", table).Scan(&relation); err != nil {
			return err
		}
		if relation == nil {
			continue
		}
		var present bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+pgx.Identifier{table}.Sanitize()+" LIMIT 1)").Scan(&present); err != nil {
			return err
		}
		if present {
			return fmt.Errorf("cannot roll back meeting preparation while %s retains confirmed configuration or effects", table)
		}
	}
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='cockpit_meeting' AND column_name='cancelled_at')").Scan(&exists); err != nil {
		return err
	}
	if exists {
		var present bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM cockpit_meeting WHERE cancelled_at IS NOT NULL OR archived_at IS NOT NULL) OR EXISTS(SELECT 1 FROM cockpit_meeting_lifecycle_command WHERE operation_id IS NOT NULL OR kind IN ('cancel','reinstate','archive','unarchive'))").Scan(&present); err != nil {
			return err
		}
		if present {
			return fmt.Errorf("cannot roll back meeting disposition while current or historical decisions remain")
		}
	}
	return nil
}
