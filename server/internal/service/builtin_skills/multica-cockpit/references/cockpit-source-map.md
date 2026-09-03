# Cockpit source map

Where each documented behaviour actually lives, so a drift in the backend is
traceable from the skill.

## API

All routes are workspace-scoped through `X-Workspace-ID`. Registered in
`server/cmd/server/router.go` under `/api/cockpit`; implemented in
`server/internal/handler/cockpit.go`.

| Method | Path | Handler |
| --- | --- | --- |
| GET | `/api/cockpit` | `GetCockpit` — the whole board |
| PATCH | `/api/cockpit` | `UpdateCockpit` |
| PUT | `/api/cockpit/import` | `ImportCockpit` (owner/admin) |
| POST | `/api/cockpit/nodes` | `CreateCockpitNode` |
| PATCH | `/api/cockpit/nodes/{id}` | `UpdateCockpitNode` |
| DELETE | `/api/cockpit/nodes/{id}` | `DeleteCockpitNode` |
| PUT | `/api/cockpit/nodes/{id}/issues` | `SetCockpitNodeIssues` |
| DELETE | `/api/cockpit/nodes/{id}/issues/{issueId}` | `DeleteCockpitNodeIssue` |
| POST | `/api/cockpit/nodes/{id}/payments` | `CreateCockpitPayment` |
| PATCH | `/api/cockpit/payments/{paymentId}` | `UpdateCockpitPayment` |
| DELETE | `/api/cockpit/payments/{paymentId}` | `DeleteCockpitPayment` |
| POST | `/api/cockpit/milestones` | `CreateCockpitMilestone` |
| PATCH | `/api/cockpit/milestones/{milestoneId}` | `UpdateCockpitMilestone` |
| DELETE | `/api/cockpit/milestones/{milestoneId}` | `DeleteCockpitMilestone` |
| POST | `/api/cockpit/meetings` | `CreateCockpitMeeting` |
| PATCH | `/api/cockpit/meetings/{meetingId}` | `UpdateCockpitMeeting` |
| DELETE | `/api/cockpit/meetings/{meetingId}` | `DeleteCockpitMeeting` |

`{id}` on a node route accepts a UUID or the node's `code`
(`loadCockpitNode`). `{issueId}` accepts a UUID or the workspace identifier
(`resolveCockpitIssue`).

## Field semantics

- Partial update: only keys present in the JSON body are written
  (`decodeCockpitBody` keeps the raw field map alongside the typed struct).
- A date key present with `null` or `""` clears the column; absent leaves it
  (`cockpitDate`). Same for `budget_amount` with `null`.
- `progress` is validated 0-100 (`progressOrError`); the column carries the
  matching CHECK.
- Amounts are `NUMERIC(14,4)` in the database and float64 on the wire
  (`numericToPtr` / `floatToNumeric`).

## Realtime

Every write publishes `protocol.EventCockpitChanged` (`cockpit:changed`) with
`{scope, action, entity}`. Browsers patch the changed row into the cached board;
`board`/`imported` means re-read.

## Import document

```json
{
  "title": "AI+医药数据平台驾驶舱",
  "goal_title": "端到端技术贯通 Demo",
  "goal_date": "2026-12-31",
  "basis": "BIO-314《六模块项目管理总表》",
  "nodes": [
    {
      "code": "L1-01", "name": "高质量数据集", "color": "#2563eb",
      "owner": "李青娇", "position": 0
    },
    {
      "code": "L3-01-08", "parent_code": "L1-01", "name": "协议签署",
      "start_date": "2026-09-05", "end_date": "2026-09-20",
      "status": "未开始", "progress": 0, "budget_amount": 30,
      "payments": [{"label": "第1笔", "pay_date": "2026-09-05", "amount": 15}],
      "issue_ids": ["BIO-314"]
    }
  ],
  "milestones": [
    {"name": "验收", "plan_date": "2026-11-30", "status": "前置准备", "node_code": "L1-01"}
  ],
  "meetings": [
    {"title": "周例会", "meet_date": "2026-09-01", "time_range": "10:00–11:00"}
  ]
}
```

The whole document commits in one transaction (`ImportCockpit`): a bad
`parent_code`, a duplicate `code` or an unparseable date rejects it entirely and
leaves the previous board untouched.

## Storage

Migrations 904-917 (fork range). Tables: `cockpit`, `cockpit_node`,
`cockpit_payment`, `cockpit_node_issue`, `cockpit_milestone`,
`cockpit_meeting`. Queries in `server/pkg/db/queries/cockpit.sql`.
