#!/usr/bin/env python3
"""Render a read-only EXPLAIN for a cockpit scale fixture; never connect to a DB."""
import argparse
import json
import re
import uuid
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("query_file", type=Path)
parser.add_argument("query_name", choices=["GetCockpitPlanSurface", "ListCockpitMeetingRegister", "GetCockpitOverviewReadModel", "GetCockpitPlanMeetingMarkers"])
parser.add_argument("--workspace-id", required=True, type=uuid.UUID)
parser.add_argument("--actor-id", type=uuid.UUID)
parser.add_argument("--project-id", type=uuid.UUID)
parser.add_argument("--module-id", type=uuid.UUID)
parser.add_argument("--search", default="")
parser.add_argument("--marker-rows-file", type=Path, help="JSON array of the fixture's exact row_key/node_ids groups")
parser.add_argument("--plan-mode", choices=["custom", "generic"], help="Marker diagnostic transaction only; never changes the benchmark session")
parser.add_argument("--analyze", action="store_true", help="Execute the SELECT when the rendered SQL is run; default only plans it")
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
if args.query_name == "GetCockpitOverviewReadModel" and not args.actor_id:
    parser.error("overview needs the fixture owner --actor-id")
source = args.query_file.read_text()
match = re.search(r"^-- name: " + re.escape(args.query_name) + r" :one\n(.*?)(?=^-- name:|\Z)", source, re.M | re.S)
if not match:
    parser.error("named query is missing in the supplied source snapshot")
def literal(value):
    return "'" + str(value).replace("'", "''") + "'"
values = {
    "workspace_id": literal(args.workspace_id), "project_id": literal(args.project_id) if args.project_id else "NULL",
    "module_id": literal(args.module_id) if args.module_id else "NULL", "node_id": "NULL", "node_ids": "ARRAY[]::uuid[]",
    "words": "ARRAY[" + ",".join(literal(word.lower()) for word in args.search.split()) + "]::text[]",
    "tracks": "ARRAY[]::text[]", "kinds": "ARRAY[]::text[]", "statuses": "ARRAY[]::text[]", "parties": "ARRAY[]::text[]", "only_flags": "ARRAY[]::text[]",
    "actor_id": literal(args.actor_id or args.workspace_id), "actor_role": "'owner'", "human": "TRUE", "as_of": "'2026-10-10'", "view": "'team'", "kind": "''", "section": "'overview'", "days": "30",
    "workflow_stage": "''", "date_from": "NULL", "date_to": "NULL", "calendar_counts": "FALSE", "cursor_key": "''", "page_size": "25",
}
if args.query_name == "GetCockpitPlanMeetingMarkers":
    if not args.marker_rows_file:
        parser.error("markers need --marker-rows-file")
    rows = json.loads(args.marker_rows_file.read_text())
    if not isinstance(rows, list) or not rows or len(rows) > 100:
        parser.error("marker rows must contain 1–100 groups")
    node_ids = set()
    for row in rows:
        if not isinstance(row.get("row_key"), str) or not row["row_key"] or len(row["row_key"]) > 100:
            parser.error("invalid marker row key")
        if not isinstance(row.get("node_ids"), list) or not 1 <= len(row["node_ids"]) <= 20:
            parser.error("invalid marker node group")
        node_ids.update(str(uuid.UUID(value)) for value in row["node_ids"])
    if len(node_ids) > 200:
        parser.error("marker rows exceed 200 distinct nodes")
    values.update({"rows": literal(json.dumps(rows)), "node_ids": "ARRAY[" + ",".join(literal(value) for value in sorted(node_ids)) + "]::uuid[]",
                   "date_from": "'2026-10-01'", "date_to": "'2026-10-28'"})
elif args.plan_mode:
    parser.error("--plan-mode is only supported for marker diagnostics")
def replace(match):
    name = match.group(1)
    if name not in values:
        parser.error("unsupported query parameter: " + name)
    return values[name]
query = re.sub(r"sqlc\.(?:arg|narg)\('([^']+)'\)", replace, match.group(1).strip())
if "sqlc." in query:
    parser.error("unresolved sqlc parameter; do not execute this file")
options = "ANALYZE, BUFFERS, FORMAT JSON" if args.analyze else "FORMAT JSON"
prefix = "BEGIN READ ONLY;\nSET LOCAL statement_timeout='25s';\n"
if args.plan_mode:
    names = ["workspace_id", "project_id", "module_id", "node_ids", "rows", "date_from", "date_to", "cursor_key"]
    prepared = re.sub(r"sqlc\.(?:arg|narg)\('([^']+)'\)", lambda item: "$" + str(names.index(item.group(1)) + 1), match.group(1).strip())
    prefix += "SET LOCAL plan_cache_mode=force_" + args.plan_mode + "_plan;\n"
    prefix += "PREPARE cockpit_marker_evidence(uuid,uuid,uuid,uuid[],jsonb,date,date,text) AS\n" + prepared + "\n"
    query = "EXECUTE cockpit_marker_evidence(" + ",".join(values[name] for name in names) + ");"
args.output.write_text(prefix + "EXPLAIN (" + options + ")\n" + query + "\nROLLBACK;\n")
