-- name: GetCockpitInputReferenceByRemovalKey :one
SELECT * FROM cockpit_input_reference WHERE workspace_id=$1 AND meeting_id=$2 AND removal_key=$3;
