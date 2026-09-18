#!/usr/bin/env python3
"""Offline cockpit v1.2 recovery. No network calls or production writes.

Default output is deliberately NOT an import document: top-level `nodes` is
an error string, so CockpitImportRequest JSON decoding rejects this package.
This recovery utility never emits an executable complete import. A full
--existing-board JSON export can enrich the blocked envelope for review.
--board-era must say whether that board precedes or follows the v1.2 renumbering.
Existing output is inspected as JSON and requires --overwrite to replace.

Targeted transcript provenance: lines 287/301 define renumbering rules;
243/297 expose recoverable links; 480/490 expose manual additions. Full
156-link mapping and extra-row detail were never printed in that transcript.
"""
import argparse
import collections
import datetime
from decimal import Decimal
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

SOURCE = Path('/Volumes/AI平台/05项目管理类/01组织规划/AI+医药数据平台驾驶舱v1.2.html')
BIO_RE = re.compile(r'BIO-\d+')
OLD_RE = re.compile(r'(L3-(\d{2})-\d{2})((?:/\d{2})*)|(\d{2}\.\d{2})')
PARTIAL_LINKS = [
    ('L1-01', 'BIO-389'), ('L1-03', 'BIO-445'),
    *[('L1-05', f'BIO-{n}') for n in (224, 275, 287, 292, 312, 314, 315, 316)],
    ('L3-06-12', 'BIO-224'),
]
EXTRA_MEETINGS = [
    ('2026-09-04', '16:30-17:30', '数据资产合规讨论'),
    ('2026-09-04', '15:00-16:30', '技术研讨例会'),
    ('2026-09-17', '', '新会议'),
    ('2026-09-18', '10:00-10:30', '复星-明略沟通会'),
]
MEETING_FIELDS = ('meet_date', 'time_range', 'title', 'attendees', 'meet_no', 'link', 'note')


def old_codes(raw):
    out = []
    for full, mod, tail, l2 in OLD_RE.findall(raw or ''):
        if l2:
            out.append(l2)
        else:
            out.append(full)
            out.extend(f'L3-{mod}-{n}' for n in re.findall(r'\d{2}', tail))
    return out


def extract(source):
    # Only the three data literal declarations are evaluated, not page scripts.
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
const ctx = vm.createContext(Object.create(null), {
  codeGeneration: {strings: false, wasm: false}
});
const code = [literal('let DATA = {', '\n'),
  literal('const MILESTONES=[', '\n];'),
  literal('const SEED_MEETINGS=[', '\n];'),
  'globalThis.result = {DATA, MILESTONES, SEED_MEETINGS};'].join('\n');
vm.runInContext(code, ctx, {timeout: 1000});
process.stdout.write(JSON.stringify(ctx.result));
'''
    return json.loads(subprocess.check_output(['node', '-e', js, str(source)], text=True))


def rename(value, replacements):
    # Replace only exact old display names, never broad words like “合规”.
    if isinstance(value, str):
        for old, new in replacements:
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [rename(v, replacements) for v in value]
    if isinstance(value, dict):
        return {k: rename(v, replacements) for k, v in value.items()}
    return value


def slot(m):
    return (m.get('meet_date') or '', re.sub(r'[‐-―~～]', '-', m.get('time_range') or '').replace(' ', ''))


def build(ex, board, era):
    data = ex['DATA']
    source_nodes = data['nodes']
    by_code = {n['id']: n for n in source_nodes}
    assert len(by_code) == len(source_nodes), 'Duplicate source IDs'
    assert by_code['03.03']['parent'] == 'L1-03'
    assert by_code['L1-04']['parent'] == 'ROOT'
    replacements = [
        (by_code['03.03']['name'], '数据与工具的开发'),
        (by_code['L1-04']['name'], '数据合规与质量体系'),
    ]
    existing = collections.defaultdict(list)
    id_to_code = {}
    if board is not None:
        for key in ('cockpit', 'nodes', 'issue_links', 'milestones', 'meetings'):
            if key not in board:
                raise ValueError(f'Incomplete board snapshot: missing {key}')
        for key in ('nodes', 'issue_links', 'milestones', 'meetings'):
            if not isinstance(board[key], list):
                raise ValueError(f'Invalid snapshot list: {key}')
        expected_links = 156 if era == 'pre-v12' else 161
        if len(board['issue_links']) != expected_links:
            raise ValueError(f'Incomplete snapshot: expected {expected_links} links')
        for row in board['milestones']:
            if not set(('name', 'plan_date', 'actual_date', 'status', 'node_id', 'condition', 'guard')) <= row.keys():
                raise ValueError('Incomplete milestone fields in snapshot')
        for row in board['meetings']:
            if not set(MEETING_FIELDS) <= row.keys():
                raise ValueError('Incomplete meeting fields in snapshot')
        id_to_code = {n['id']: n['code'] for n in board['nodes']}
        if len(id_to_code) != len(board['nodes']) or len(set(id_to_code.values())) != len(id_to_code):
            raise ValueError('Duplicate snapshot node ID/code')
        for link in board['issue_links']:
            code = id_to_code[link['node_id']]
            ref = link.get('issue_identifier') or link.get('issue_id')
            if not ref:
                raise ValueError('Snapshot contains an issue link without an identifier')
            existing[code].append(ref)
    else:
        for code, ref in PARTIAL_LINKS:
            existing[code].append(ref)

    consumed = set()
    nodes = []
    for pos, n in enumerate(source_nodes):
        codes = [n['id']]
        if era == 'pre-v12' and n['l1'] in ('L1-05', 'L1-06') and n['type'] == 'yg':
            codes = old_codes(n.get('oldcode'))
        refs = BIO_RE.findall(n.get('bio') or '')
        for code in codes:
            refs.extend(existing.get(code, []))
            consumed.add(code)
        nodes.append({
            'code': n['id'], 'parent_code': '' if n['parent'] == 'ROOT' else n['parent'],
            'name': n['name'], 'position': pos,
            'color': n.get('color', '') if n['type'] == 'l1' else '',
            **{out: n.get(src) or '' for out, src in (
                ('owner', 'owner'), ('collaborators', 'collab'), ('start_date', 'start'),
                ('end_date', 'end'), ('status', 'status'), ('deliverable', 'deliverable'),
                ('dependencies', 'deps'), ('note', 'note'), ('vendor', 'vendor'),
                ('budget_category', 'budcat'), ('exec_status', 'execStatus'), ('source', 'source'))},
            'progress': float(n.get('progress') or 0),
            'budget_amount': float(n['ybudget']) if n.get('ybudget') is not None else None,
            'current_progress': '', 'contract': '',
            'payments': [{'label': p.get('label') or '', 'pay_date': p.get('d') or '',
                          'amount': float(p.get('amt') or 0)} for p in n.get('pays') or []],
            'issue_ids': list(dict.fromkeys(refs)),
        })
    # Insert the empty L2 immediately after the last source L2 of module 04.
    assert '04.04' not in by_code, 'Source already has 04.04: inspect instead of duplicating'
    empty = {k: '' for k in nodes[0]}
    empty.update(code='04.04', parent_code='L1-04', name='质量线', position=0,
                 progress=0, budget_amount=None, payments=[], issue_ids=[])
    idx = max(i for i, n in enumerate(nodes) if n['parent_code'] == 'L1-04') + 1
    nodes.insert(idx, empty)
    for i, n in enumerate(nodes):
        n['position'] = i

    milestones = [{
        'name': m['name'], 'position': i,
        **{out: m.get(src) or '' for out, src in (
            ('plan_date', 'plan'), ('actual_date', 'actual'), ('status', 'status'),
            ('node_code', 'l1'), ('condition', 'cond'), ('guard', 'guard'))},
    } for i, m in enumerate(ex['MILESTONES'])]
    meetings = [{out: m.get(src) or '' for out, src in (
        ('meet_date', 'date'), ('time_range', 'time'), ('title', 'title'),
        ('attendees', 'attendees'), ('meet_no', 'meetNo'), ('link', 'link'), ('note', 'note'))
    } for m in ex['SEED_MEETINGS']]
    if board is not None:
        names = {m['name'] for m in milestones}
        for m in board['milestones']:
            if m['name'] not in names:
                extra = {k: m.get(k) or '' for k in ('name', 'plan_date', 'actual_date', 'status', 'condition', 'guard')}
                extra.update(node_code=id_to_code[m['node_id']] if m.get('node_id') else '', position=len(milestones))
                milestones.append(extra)
                names.add(m['name'])
        slots = {slot(m) for m in meetings}
        for m in board['meetings']:
            if slot(m) not in slots:
                meetings.append({k: m.get(k) or '' for k in MEETING_FIELDS})
                slots.add(slot(m))
    else:
        # Unknown fields stay blank; their absence is recorded in recovery metadata.
        milestones.append(dict(name='治理与人机协同机制建立并实际运行', plan_date='2026-12-31',
            actual_date='', status='按计划推进', node_code='', condition='', guard='', position=len(milestones)))
        for date, time, title in EXTRA_MEETINGS:
            meetings.append({**dict.fromkeys(MEETING_FIELDS, ''), 'meet_date': date, 'time_range': time, 'title': title})

    doc = dict(title='AI+医药数据平台驾驶舱', goal_title=data['goals'][0]['name'],
               goal_date=re.sub(r'\(.*\)$', '', data['goals'][0]['date']).strip(),
               basis=data['meta']['basis'], nodes=nodes, milestones=milestones, meetings=meetings)
    # Summary cards are intentionally absent, preserving current server-authored cards.
    doc = rename(doc, replacements)
    unclaimed = [{'node_code': c, 'issue_ids': existing[c]} for c in sorted(set(existing) - consumed)]
    validate(doc)
    validate_totals(doc)
    return doc, unclaimed, replacements


def validate(doc):
    nodes = doc['nodes']
    codes = {n['code'] for n in nodes}
    assert len(codes) == len(nodes), 'Duplicate node code'
    by_code = {n['code']: n for n in nodes}
    for n in nodes:
        assert not n['parent_code'] or n['parent_code'] in codes, f'Dangling parent: {n["code"]}'
        seen = set()
        curr = n['code']
        while curr:
            assert curr not in seen, f'Cycle: {curr}'
            seen.add(curr)
            curr = by_code[curr]['parent_code']
        if re.fullmatch(r'\d{2}\.\d{2}', n['code']):
            assert n['parent_code'] == f'L1-{n["code"][:2]}', f'Wrong L2 parent: {n["code"]}'
    assert by_code['03.03']['name'] == '数据与工具的开发'
    assert by_code['L1-04']['name'] == '数据合规与质量体系'
    quality = by_code['04.04']
    for k, v in quality.items():
        if k not in ('code', 'parent_code', 'name', 'position'):
            assert v in ('', 0, None, []), f'Invented quality-line field: {k}'
    for m in doc['milestones']:
        assert not m['node_code'] or m['node_code'] in codes, 'Dangling milestone node'


def validate_totals(doc):
    nodes = {n['code']: n for n in doc['nodes']}
    assert len(nodes) == len(doc['nodes']) == 188
    for n in doc['nodes']:
        visited = set()
        cursor = n['code']
        while cursor:
            assert cursor in nodes, f'Missing parent {cursor}'
            assert cursor not in visited, f'Cycle {cursor}'
            visited.add(cursor)
            cursor = nodes[cursor]['parent_code']
        for k in ('start_date','end_date'):
            if n[k]:
                datetime.date.fromisoformat(n[k])
        assert 0 <= n['progress'] <= 100
    assert nodes['03.03']['name'] == '数据与工具的开发'
    assert nodes['L1-04']['name'] == '数据合规与质量体系'
    new = nodes['04.04']
    assert new['parent_code'] == 'L1-04' and new['name'] == '质量线'
    for key, value in new.items():
        if key not in ('code','parent_code','name','position'):
            assert value in ('', 0, None, []), f'Invented new-node field {key}'
    assert [c for c in nodes if re.fullmatch(r'04\.\d{2}', c)] == ['04.01','04.02','04.03','04.04']
    payments = [p for n in doc['nodes'] for p in n['payments']]
    budgets = [n['budget_amount'] for n in doc['nodes'] if n['budget_amount'] is not None]
    assert len(payments) == 34 and len(budgets) == 22
    assert sum(Decimal(str(p['amount'])) for p in payments) == Decimal('1259.8048')
    assert sum(Decimal(str(b)) for b in budgets) == Decimal('1295.0048')
    assert len(doc['milestones']) == 7 and len(doc['meetings']) == 9
    datetime.date.fromisoformat(doc['goal_date'])
    for m in doc['milestones']:
        assert not m['node_code'] or m['node_code'] in nodes
        for key in ('plan_date', 'actual_date'):
            if m[key]: datetime.date.fromisoformat(m[key])
    for m in doc['meetings']:
        if m['meet_date']: datetime.date.fromisoformat(m['meet_date'])
    return dict(nodes=len(nodes), payments=len(payments), budgets=len(budgets),
        milestones=len(doc['milestones']), meetings=len(doc['meetings']),
        issue_links=sum(len(n['issue_ids']) for n in doc['nodes']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument('--existing-board', type=Path)
    parser.add_argument('--board-era', choices=('pre-v12', 'v12'))
    parser.add_argument('--complete', action='store_true')
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('cockpit-import-v1.2.PARTIAL.json'))
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()
    if args.existing_board and not args.board_era:
        parser.error('--existing-board requires --board-era to avoid silently misrouting links')
    if args.complete:
        parser.error('REFUSED: recovery utility only emits blocked PARTIAL envelopes; no complete import is supported')
    protected = [args.source, Path(__file__)]
    if args.existing_board:
        protected.append(args.existing_board)
    if any(args.output.resolve() == item.resolve() for item in protected):
        parser.error('Refusing to overwrite source, builder, or snapshot')
    if args.output.exists():
        previous = json.loads(args.output.read_text(encoding='utf-8'))
        print(f'Inspected existing output: status={previous.get("status", "import-document")}', file=sys.stderr)

    board = json.loads(args.existing_board.read_text(encoding='utf-8')) if args.existing_board else None
    before = hashlib.sha256(args.source.read_bytes()).hexdigest()
    doc, unclaimed, replacements = build(extract(args.source), board, args.board_era or 'pre-v12')
    if unclaimed:
        parser.error(f'REFUSED: snapshot links have unclaimed node codes: {unclaimed}')
    counts = dict(nodes=len(doc['nodes']), payments=sum(len(n['payments']) for n in doc['nodes']),
                  budgets=sum(n['budget_amount'] is not None for n in doc['nodes']),
                  milestones=len(doc['milestones']), meetings=len(doc['meetings']),
                  issue_links=sum(len(n['issue_ids']) for n in doc['nodes']))
    if not args.complete:
        missing = [] if board else [
            'Full 156-link pre-v1.2 node_code→issue mapping (or full v1.2 board snapshot); transcript printed 11 exact existing pairs; 145 of 156 existing pairs remain unrecovered.',
            'Extra milestone actual_date/node_code/condition/guard are not recoverable from printed results.',
            'Four manual meetings attendees/meet_no/link/note are not recoverable from printed results.',
        ]
        output = dict(status='PARTIAL', ready_for_import=False, nodes='BLOCKED: not a CockpitImportRequest; do not import this recovery envelope',
            document=doc, recovery=dict(source_path=str(args.source), source_sha256=before,
                transcript_id='e661a583-4b93-49ed-b6fb-09f5eb15b924', counts=counts,
                prior_validated_counts=dict(nodes=187, payments=34, budgets=22, milestones=7, meetings=9, issue_links=161),
                recovered_existing_link_pairs=len(PARTIAL_LINKS) if board is None else len(board['issue_links']),
                missing=missing, unclaimed_links=unclaimed, name_replacements=replacements,
                unknown_manual_fields=[] if board else [
                    dict(kind='milestone', name='治理与人机协同机制建立并实际运行', fields=['actual_date', 'node_code', 'condition', 'guard']),
                    *[dict(kind='meeting', meet_date=d, time_range=t, title=title,
                           fields=['attendees', 'meet_no', 'link', 'note']) for d, t, title in EXTRA_MEETINGS]],
                complete_generation_requires='Not supported by this utility. Recover full mapping and manual-row fields, review a full authenticated snapshot with explicit era, then separately authorize import preparation.',
                consolidation=dict(canonical_builder='build-import.py', compared_inputs=['build-import.py', 'build_import.py', 'cockpit-import-v1.2.PARTIAL.json', 'cockpit-import-v1.2.draft.json'],
                    data_differences='Both documents have identical keyed node fields except positions; identical title, goal, basis, milestones, meetings and 93 links. Keep hyphen placement of empty 04.04 after existing L2 directions, before L3 rows.',
                    chosen_guards='Union of hierarchy/parent/cycle/empty-line checks, exact financial counts and Decimal totals, date/progress validation, sandbox timeout, source digest, explicit board era, snapshot field/count checks, unclaimed-link rejection, input/output collision protection and inspected explicit overwrite. Complete output disabled.',
                    recovered_pair='Additional evidenced old L3-06-12→BIO-224 is retained and maps through oldcode to new L3-06-11; draft document already has this link from HTML, so total remains 93.'),
                note='New 04.04 adds one empty L2, so expected node count is now 188. Missing manual fields are blanks, not confirmed empty values.'))
    else:
        output = doc
    assert hashlib.sha256(args.source.read_bytes()).hexdigest() == before, 'Source changed during extraction'
    encoded = json.dumps(output, ensure_ascii=False, indent=2) + '\n'
    if args.output.exists():
        if args.output.read_text(encoding='utf-8') != encoded:
            if not args.overwrite:
                parser.error('Output differs; inspect it and explicitly pass --overwrite')
            args.output.write_text(encoded, encoding='utf-8')
    else:
        with args.output.open('x', encoding='utf-8') as handle:
            handle.write(encoded)
    print(json.dumps(dict(output=str(args.output), status='complete' if args.complete else 'PARTIAL', counts=counts), ensure_ascii=False))
    if board is None:
        print('PARTIAL: never use document for replacement until full mapping and manual-row detail are recovered.', file=sys.stderr)


if __name__ == '__main__':
    main()
