#!/usr/bin/env python3
"""One-click import of the BayClaw bio-agent preset into a target workspace.

Reads preset.json (skills + agents + squad, fully inlined) and recreates the
whole team in a workspace via the public API. Idempotent by name: a skill or
agent that already exists is reused, not duplicated, so re-running tops up a
partial import instead of erroring.

Container images are NOT built here — they are a host-level, build-once step.
The script prints the exact build commands at the end; run them once per host.

Usage:
  API=http://127.0.0.1:18080 \
  JWT=<owner token for the target workspace> \
  WS=<target workspace uuid> \
  [RUNTIME_ID=<runtime uuid>]   # optional; auto-picks a public runtime if unset
  python3 import_preset.py [path/to/preset.json]

The token must belong to an owner/admin of WS (squad creation requires it).
"""
import json, os, sys, urllib.request, urllib.error

API = os.environ["API"].rstrip("/")
JWT = os.environ["JWT"]
WS = os.environ["WS"]
RUNTIME_ID = os.environ.get("RUNTIME_ID", "")
PRESET = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "preset.json")
H = {"Authorization": f"Bearer {JWT}", "X-Workspace-ID": WS, "Content-Type": "application/json"}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers=H)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode(errors="replace")[:200]}


def as_list(v, key):
    return v if isinstance(v, list) else (v or {}).get(key, [])


def pick_runtime():
    if RUNTIME_ID:
        return RUNTIME_ID
    _, rts = call("GET", "/api/runtimes")
    for rt in as_list(rts, "runtimes"):
        # Prefer a public/shared runtime — that's what agents can bind to.
        if rt.get("visibility") == "public":
            return rt["id"]
    # Fall back to the first runtime of any kind.
    items = as_list(rts, "runtimes")
    if items:
        return items[0]["id"]
    sys.exit("no runtime available in target workspace — provision one first "
             "(the SHARED_RUNNER mechanism adds a public runtime automatically)")


def main():
    bundle = json.load(open(PRESET, encoding="utf-8"))
    print(f"importing preset '{bundle['title']}' into workspace {WS}")

    runtime_id = pick_runtime()
    print(f"  runtime: {runtime_id}")

    # 1a) Inline (hand-authored) skills — create with full content, reuse by name.
    _, existing = call("GET", "/api/skills")
    skill_id = {s["name"]: s["id"] for s in as_list(existing, "skills")}
    for s in bundle.get("skills_inline", []):
        if s["name"] in skill_id:
            print(f"  skill = {s['name']} (reuse)")
            continue
        st, resp = call("POST", "/api/skills", {
            "name": s["name"], "description": s["description"],
            "content": s["content"], "config": {},
            "files": s.get("files", []),
        })
        if st in (200, 201) and resp:
            skill_id[s["name"]] = (resp.get("skill") or resp).get("id")
            print(f"  skill + {s['name']} ({len(s.get('files', []))} files, inline)")
        else:
            print(f"  skill ! {s['name']} FAILED {st} {resp}")

    # 1b) GitHub-sourced skills — re-import via the API (server fetches GitHub).
    #     Retries once on the occasional 502 from the upstream fetch.
    for s in bundle.get("skills_import", []):
        if s["name"] in skill_id:
            print(f"  skill = {s['name']} (reuse)")
            continue
        for attempt in (1, 2):
            st, resp = call("POST", "/api/skills/import",
                            {"url": s["source_url"], "on_conflict": "skip"})
            if st in (200, 201):
                break
        if st in (200, 201) and resp:
            sid = (resp.get("skill") or resp).get("id")
            if sid:
                skill_id[s["name"]] = sid
            else:
                _, again = call("GET", "/api/skills")
                skill_id.update({x["name"]: x["id"] for x in as_list(again, "skills")})
            print(f"  skill + {s['name']} (imported from GitHub)")
        else:
            print(f"  skill ! {s['name']} import FAILED {st} {resp}")
    # Refresh the map so any name drift between our label and the upstream
    # frontmatter `name` is reconciled before binding.
    _, allsk = call("GET", "/api/skills")
    for x in as_list(allsk, "skills"):
        skill_id.setdefault(x["name"], x["id"])

    # 2) Agents — create with mcp_config, then bind skills.
    _, ex_agents = call("GET", "/api/agents")
    agent_id = {a["name"]: a["id"] for a in as_list(ex_agents, "agents")}
    for a in bundle["agents"]:
        if a["name"] in agent_id:
            aid = agent_id[a["name"]]
            print(f"  agent = {a['name']} (reuse)")
        else:
            body = {
                "name": a["name"], "description": a["description"],
                "instructions": a["instructions"], "runtime_id": runtime_id,
                "mcp_config": a.get("mcp_config") or {},
                "visibility": "workspace",
                "max_concurrent_tasks": a.get("max_concurrent_tasks", 1),
            }
            if a.get("avatar_url"):
                body["avatar_url"] = a["avatar_url"]
            st, resp = call("POST", "/api/agents", body)
            if st not in (200, 201) or not resp:
                print(f"  agent ! {a['name']} FAILED {st} {resp}")
                continue
            aid = resp["id"]
            agent_id[a["name"]] = aid
            print(f"  agent + {a['name']}")
        # Bind skills (idempotent PUT).
        ids = [skill_id[n] for n in a["skill_names"] if n in skill_id]
        call("PUT", f"/api/agents/{aid}/skills", {"skill_ids": ids})
        print(f"      bound {len(ids)} skills, mcp={list((a.get('mcp_config') or {}).get('mcpServers', {}))}")

    # 3) Squad — create with leader, add the rest as members.
    _, ex_squads = call("GET", "/api/squads")
    squad_by_name = {s["name"]: s["id"] for s in as_list(ex_squads, "squads")}
    for sq in bundle.get("squads", []):
        leader = agent_id.get(sq["leader_name"])
        if not leader:
            print(f"  squad ! {sq['name']} skipped (leader missing)")
            continue
        if sq["name"] in squad_by_name:
            sid = squad_by_name[sq["name"]]
            print(f"  squad = {sq['name']} (reuse)")
        else:
            st, resp = call("POST", "/api/squads", {
                "name": sq["name"], "description": sq["description"], "leader_id": leader,
            })
            if st not in (200, 201) or not resp:
                print(f"  squad ! {sq['name']} FAILED {st} {resp}")
                continue
            sid = resp["id"]
            print(f"  squad + {sq['name']} (leader: {sq['leader_name']})")
        # Existing members (leader auto-added on create).
        _, mems = call("GET", f"/api/squads/{sid}/members")
        have = {m.get("member_id") for m in as_list(mems, "members")}
        for nm in sq["member_names"]:
            mid = agent_id.get(nm)
            if not mid or mid in have:
                continue
            st, _ = call("POST", f"/api/squads/{sid}/members",
                         {"member_type": "agent", "member_id": mid, "role": "member"})
            print(f"      member + {nm} ({st})")

    # 4) Host-level build-once steps (images + ToolUniverse MCP).
    here = os.path.dirname(os.path.abspath(__file__))
    print("\nnext (once per host):")
    print("  # ToolUniverse MCP — pre-install so agent cold-start is ~7s, not minutes:")
    print("  uv tool install tooluniverse   # exposes tooluniverse-smcp-stdio on PATH")
    print("  # Bioinformatics sandbox images:")
    for img in bundle.get("container_images", []):
        print(f"  docker build -f {here}/{img['dockerfile']} "
              f"-t {img['tag']} {here}    # {img['stack']}")
    print("\ndone.")


if __name__ == "__main__":
    main()
