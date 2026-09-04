# Cockpit reference

The board's HTTP surface, the field rules every write obeys, what a write
broadcasts, and the shape of an import document.

## API

Every route is workspace-scoped through the `X-Workspace-ID` header.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/cockpit` | the whole board in one read |
| PATCH | `/api/cockpit` | board title, goal, goal date, basis |
| PUT | `/api/cockpit/import` | replace the board (owner/admin only) |
| POST | `/api/cockpit/nodes` | add a work-breakdown node |
| PATCH | `/api/cockpit/nodes/{id}` | edit a node |
| DELETE | `/api/cockpit/nodes/{id}` | delete a leaf node |
| PUT | `/api/cockpit/nodes/{id}/issues` | replace a node's issue links |
| DELETE | `/api/cockpit/nodes/{id}/issues/{issueId}` | unlink one issue |
| POST | `/api/cockpit/nodes/{id}/payments` | add an instalment |
| PATCH | `/api/cockpit/payments/{paymentId}` | edit an instalment |
| DELETE | `/api/cockpit/payments/{paymentId}` | delete an instalment |
| POST | `/api/cockpit/milestones` | add a milestone |
| PATCH | `/api/cockpit/milestones/{milestoneId}` | edit a milestone |
| DELETE | `/api/cockpit/milestones/{milestoneId}` | delete a milestone |
| POST | `/api/cockpit/meetings` | add a meeting |
| PATCH | `/api/cockpit/meetings/{meetingId}` | edit a meeting |
| DELETE | `/api/cockpit/meetings/{meetingId}` | delete a meeting |

`{id}` on a node route accepts either a UUID or the node's own `code`, so
`L3-01-08` works everywhere a UUID does. `{issueId}` accepts either a UUID or
the workspace issue identifier such as `BIO-314`.

## Field semantics

- A write is a partial update: only the keys present in the JSON body are
  written, and every other column keeps its value.
- Sending a date key as `null` or `""` clears it; leaving the key out entirely
  leaves it unchanged. `budget_amount` behaves the same way with `null`.
- `progress` is a number 0-100; fractional values such as `62.5` are accepted.
  Anything outside that range is rejected with 400 rather than clamped.
- Amounts keep four decimal places server-side and travel as plain JSON
  numbers, so a value read back may carry more precision than it was sent with.

## Realtime

Every write broadcasts a `cockpit:changed` event carrying
`{scope, action, entity}`. A client patches the changed row into its cached
board; a `board` or `imported` scope means the board changed wholesale and has
to be re-read.

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

The whole document commits in one transaction: a bad `parent_code`, a duplicate
`code` or an unparseable date rejects it entirely and leaves the previous board
untouched.

## Storage

The board is one record per workspace with five collections hanging off it:
nodes, instalments, node-to-issue links, milestones and meetings. Deleting a
node clears its own instalments and its own issue links. A node that still has
children is refused with 409 rather than cascaded, so delete or reparent the
children first.
