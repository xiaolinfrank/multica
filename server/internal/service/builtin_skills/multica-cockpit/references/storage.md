## Storage

The board is one record per workspace with seven collections hanging off it:
nodes, instalments, node-to-issue links, milestones, meetings, meeting-to-issue
links and meeting-to-work-item links. Deleting a node clears its own
instalments, its own issue links and its meeting links; deleting a meeting
clears both of its link sets. A node that still has children is refused with
409 rather than cascaded, so delete or reparent the children first.

A meeting's folder on the shared storage is NEVER deleted with the meeting: it
may hold the only copy of the minutes.
