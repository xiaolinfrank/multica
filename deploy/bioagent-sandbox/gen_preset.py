#!/usr/bin/env python3
"""Generate the BayClaw bio-agent preset bundle from a live workspace.

Reads the fully-configured source workspace (agents + their instructions,
mcp_config and skill bindings; every skill's content and files; the squad)
and emits a single self-contained preset.json. The bundle stores skill
content inline so import never depends on upstream GitHub availability, and
keeps each skill's source URL for provenance.

Usage:
  API=http://127.0.0.1:18080 JWT=<owner jwt> WS=<workspace uuid> \
    python3 gen_preset.py > preset.json
"""
import json, os, sys, urllib.request

API = os.environ["API"]; JWT = os.environ["JWT"]; WS = os.environ["WS"]
H = {"Authorization": f"Bearer {JWT}", "X-Workspace-ID": WS}


def get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(API + path, headers=H)))


def as_list(v, key):
    return v if isinstance(v, list) else v.get(key, [])


# --- Skills, split two ways to keep the bundle lean and license-clean ---
#   * GitHub-sourced skills (have an origin source_url) are stored as a URL
#     reference only — the importer re-fetches them via /api/skills/import.
#     This avoids vendoring third-party (some proprietary) skill content into
#     this repo and keeps preset.json small.
#   * Hand-authored skills (no source_url: the in-house retrieval skills and
#     the container-sandbox bridge) are stored inline with full content+files,
#     so import never depends on anything external for our own material.
skills_import = []   # [{name, source_url}]
skills_inline = []   # [{name, description, content, files}]
skill_id_to_name = {}
for s in as_list(get("/api/skills"), "skills"):
    d = get(f"/api/skills/{s['id']}")
    skill_id_to_name[s["id"]] = d["name"]
    origin = (d.get("config") or {}).get("origin") or {}
    url = origin.get("source_url") or origin.get("url") or ""
    if url:
        skills_import.append({"name": d["name"], "source_url": url})
    else:
        skills_inline.append({
            "name": d["name"],
            "description": d.get("description", ""),
            "content": d.get("content", ""),
            "files": [{"path": f["path"], "content": f.get("content", "")} for f in d.get("files", [])],
        })

# --- Agents: instructions, mcp_config, skill names ---
agents_out = []
agent_id_to_name = {}
for a in as_list(get("/api/agents"), "agents"):
    d = get(f"/api/agents/{a['id']}")
    agent_id_to_name[d["id"]] = d["name"]
    agents_out.append({
        "name": d["name"],
        "description": d.get("description", ""),
        "instructions": d.get("instructions", ""),
        "avatar_url": d.get("avatar_url") or "",
        "mcp_config": d.get("mcp_config") or {},
        "max_concurrent_tasks": d.get("max_concurrent_tasks", 1),
        "skill_names": [sk["name"] for sk in d.get("skills", [])],
    })

# --- Squad: resolve leader/members to names via the members endpoint ---
# The list endpoint omits membership; /members returns one row per agent with
# its role (leader/member), so we read it per squad.
squads_out = []
for sq in as_list(get("/api/squads"), "squads"):
    members = as_list(get(f"/api/squads/{sq['id']}/members"), "members")
    leader = ""
    member_names = []
    for mem in members:
        nm = agent_id_to_name.get(mem.get("member_id")) or mem.get("name") or ""
        if not nm:
            continue
        if mem.get("role") == "leader":
            leader = nm
        else:
            member_names.append(nm)
    squads_out.append({
        "name": sq.get("name", ""),
        "description": sq.get("description", ""),
        "leader_name": leader,
        "member_names": member_names,
    })

bundle = {
    "preset": "bayclaw-biopharma",
    "title": "BayClaw 生物医药情报套件",
    "description": "复星医药大湾区虚拟员工平台预制套件:6 个生物医药智能体(文献/临床/靶点/法规/生信/主管)、"
                   "21 个技能(检索+办公产出+临床法规深度+生信分析+容器沙箱)、ToolUniverse MCP、"
                   "以及 R/Python 生信容器镜像。",
    "container_images": [
        {"tag": "bayclaw/bioinformatics:r", "dockerfile": "Dockerfile.r", "env": "env-r.yaml",
         "stack": "DESeq2,edgeR,limma,clusterProfiler,survival,survminer,tidyverse,pheatmap"},
        {"tag": "bayclaw/bioinformatics:py", "dockerfile": "Dockerfile.py", "env": "env-py.yaml",
         "stack": "scanpy,anndata,pydeseq2,lifelines,samtools,bcftools,seqkit,fastqc,multiqc"},
    ],
    "skills_import": skills_import,
    "skills_inline": skills_inline,
    "agents": agents_out,
    "squads": squads_out,
}
json.dump(bundle, sys.stdout, ensure_ascii=False, indent=2)
