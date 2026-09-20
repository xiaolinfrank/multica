#!/usr/bin/env python3
"""Build the v1.2b cockpit import document from the re-authored v1.2 HTML.

The HTML gained 04.04 as a real node and renamed 03.03 to 数据、工具与方法准备
(the author's own rename, superseding the 2026-09-18 manual one). Everything else
in the HTML data is byte-identical to the 2026-09-18 import, so this merge keeps
the board's live operational data: issue links by code, the manual 7th milestone,
manual meetings by (date, normalized time) slot, and the server-side summary_*
overrides (keys omitted entirely — absent means "keep current server value").
"""
import collections
import datetime
import json
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).parent
SOURCE = Path('/Volumes/AI平台/05项目管理类/01组织规划/AI+医药数据平台驾驶舱v1.2.html')
BOARD = HERE / 'backup' / 'prod-board-20260920-export.json'
OUTPUT = HERE / 'cockpit-import-v1.2b.json'
BIO_RE = re.compile(r'BIO-\d+')
FIELD_MAP = (
    ('owner', 'owner'), ('collaborators', 'collab'), ('start_date', 'start'),
    ('end_date', 'end'), ('status', 'status'), ('deliverable', 'deliverable'),
    ('dependencies', 'deps'), ('note', 'note'), ('vendor', 'vendor'),
    ('budget_category', 'budcat'), ('exec_status', 'execStatus'), ('source', 'source'),
)
MEETING_FIELDS = ('meet_date', 'time_range', 'title', 'attendees', 'meet_no', 'link', 'note')
MILESTONE_FIELDS = ('name', 'plan_date', 'actual_date', 'status', 'condition', 'guard')


def extract(source):
    # Evaluate only the three data literals in a sandbox; never page scripts.
    js = r'''
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
function literal(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error('Missing data declaration: ' + start);
  return src.slice(i, j + end.length);
}
const ctx = vm.createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}});
vm.runInContext([literal('let DATA = {', '\n'), literal('const MILESTONES=[', '\n];'),
  literal('const SEED_MEETINGS=[', '\n];'), 'globalThis.result = {DATA, MILESTONES, SEED_MEETINGS};'].join('\n'),
  ctx, {timeout: 1000});
process.stdout.write(JSON.stringify(ctx.result));
'''
    return json.loads(subprocess.check_output(['node', '-e', js, str(source)], text=True))


def slot(meeting):
    time = re.sub(r'[‐-―~～]', '-', meeting.get('time_range') or '').replace(' ', '')
    return (meeting.get('meet_date') or '', time)


def build(ex, board):
    data = ex['DATA']
    source_nodes = data['nodes']
    by_code = {n['id']: n for n in source_nodes}
    assert len(by_code) == len(source_nodes) == 188, 'Expected the re-authored 188-node source'
    assert by_code['04.04']['type'] == 'l2' and by_code['04.04']['name'] == '质量线'

    id_to_code = {n['id']: n['code'] for n in board['nodes']}
    existing = collections.defaultdict(list)
    for link in board['issue_links']:
        code = id_to_code[link['node_id']]
        ref = link.get('issue_identifier') or link.get('issue_id')
        assert ref, 'Snapshot issue link without an identifier'
        existing[code].append(ref)

    nodes = []
    for pos, n in enumerate(source_nodes):
        refs = BIO_RE.findall(n.get('bio') or '')
        refs.extend(existing.get(n['id'], []))
        nodes.append({
            'code': n['id'], 'parent_code': '' if n['parent'] == 'ROOT' else n['parent'],
            'name': n['name'], 'position': pos,
            # L2 colours repeat their module colour and the UI derives row colour
            # from the module root; only L1 rows carry a colour in the HTML left column.
            'color': n.get('color', '') if n['type'] == 'l1' else '',
            **{out: n.get(src) or '' for out, src in FIELD_MAP},
            'progress': float(n.get('progress') or 0),
            'budget_amount': float(n['ybudget']) if n.get('ybudget') is not None else None,
            'current_progress': '', 'contract': '',
            'payments': [{'label': p.get('label') or '', 'pay_date': p.get('d') or '',
                          'amount': float(p.get('amt') or 0)} for p in n.get('pays') or []],
            'issue_ids': list(dict.fromkeys(refs)),
        })

    milestones = [{
        'name': m['name'], 'position': i,
        **{out: m.get(src) or '' for out, src in (
            ('plan_date', 'plan'), ('actual_date', 'actual'), ('status', 'status'),
            ('node_code', 'l1'), ('condition', 'cond'), ('guard', 'guard'))},
    } for i, m in enumerate(ex['MILESTONES'])]
    names = {m['name'] for m in milestones}
    for m in board['milestones']:
        if m['name'] not in names:
            extra = {k: m.get(k) or '' for k in MILESTONE_FIELDS}
            extra.update(node_code=id_to_code[m['node_id']] if m.get('node_id') else '',
                         position=len(milestones))
            milestones.append(extra)
            names.add(m['name'])

    meetings = [{out: m.get(src) or '' for out, src in (
        ('meet_date', 'date'), ('time_range', 'time'), ('title', 'title'),
        ('attendees', 'attendees'), ('meet_no', 'meetNo'), ('link', 'link'), ('note', 'note'))
    } for m in ex['SEED_MEETINGS']]
    slots = {slot(m) for m in meetings}
    for m in board['meetings']:
        if slot(m) not in slots:
            meetings.append({k: m.get(k) or '' for k in MEETING_FIELDS})
            slots.add(slot(m))

    doc = dict(title='AI+医药数据平台驾驶舱', goal_title=data['goals'][0]['name'],
               goal_date=re.sub(r'\(.*\)$', '', data['goals'][0]['date']).strip(),
               basis=data['meta']['basis'], nodes=nodes, milestones=milestones, meetings=meetings)
    # summary_* intentionally absent: keep the server-side values (the operator's
    # manual 未来两周重点 override must survive the re-import).
    return doc


def validate(doc):
    nodes = {n['code']: n for n in doc['nodes']}
    assert len(nodes) == len(doc['nodes']) == 188
    for n in doc['nodes']:
        assert not n['parent_code'] or n['parent_code'] in nodes, f'Dangling parent: {n["code"]}'
        seen, curr = set(), n['code']
        while curr:
            assert curr not in seen, f'Cycle: {curr}'
            seen.add(curr)
            curr = nodes[curr]['parent_code']
        for k in ('start_date', 'end_date'):
            if n[k]:
                datetime.date.fromisoformat(n[k])
        assert 0 <= n['progress'] <= 100
    assert nodes['03.03']['name'] == '数据、工具与方法准备', nodes['03.03']['name']
    assert nodes['L1-04']['name'] == '数据合规与质量体系'
    quality = nodes['04.04']
    assert quality['parent_code'] == 'L1-04' and quality['name'] == '质量线'
    for key, value in quality.items():
        if key not in ('code', 'parent_code', 'name', 'position'):
            assert value in ('', 0, None, []), f'Unexpected 04.04 field: {key}={value!r}'
    payments = [p for n in doc['nodes'] for p in n['payments']]
    budgets = [n['budget_amount'] for n in doc['nodes'] if n['budget_amount'] is not None]
    assert len(payments) == 34 and sum(Decimal(str(p['amount'])) for p in payments) == Decimal('1259.8048')
    budgets_total = sum(Decimal(str(b)) for b in budgets)
    assert len(budgets) == 22 and budgets_total == Decimal('1295.0048'), budgets_total
    assert len(doc['milestones']) == 7 and len(doc['meetings']) == 10
    datetime.date.fromisoformat(doc['goal_date'])
    for m in doc['milestones']:
        assert not m['node_code'] or m['node_code'] in nodes
    links = sum(len(n['issue_ids']) for n in doc['nodes'])
    assert links == 179, links
    for m in doc['meetings']:
        if m['meet_date']:
            datetime.date.fromisoformat(m['meet_date'])
    return dict(nodes=len(nodes), payments=len(payments), budgets=len(budgets),
                issue_links=links, milestones=len(doc['milestones']), meetings=len(doc['meetings']))


def main():
    if OUTPUT.exists():
        sys.exit(f'{OUTPUT.name} already exists; inspect it or remove it first')
    board = json.loads(BOARD.read_text(encoding='utf-8'))
    for key in ('nodes', 'issue_links', 'milestones', 'meetings'):
        assert isinstance(board.get(key), list) and board[key], f'Incomplete snapshot: {key}'
    doc = build(extract(SOURCE), board)
    counts = validate(doc)
    OUTPUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(OUTPUT), 'counts': counts}, ensure_ascii=False))


if __name__ == '__main__':
    main()
