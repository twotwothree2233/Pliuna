#!/usr/bin/env python3
"""Validate contract artifacts without touching a real application database."""
import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import unquote

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit('Missing jsonschema; schema checks were NOT run.')

ROOT = Path(__file__).resolve().parents[2]
BASE = Path(__file__).resolve().parent
schema = json.loads((BASE / 'schemas/core.schema.json').read_text())
Draft202012Validator.check_schema(schema)
fixtures = json.loads((BASE / 'examples/manifest.json').read_text())
for fixture in fixtures:
    selected = {**schema, '$ref': '#/$defs/' + fixture['definition']}
    value = json.loads((BASE / fixture['file']).read_text())
    errors = list(Draft202012Validator(selected).iter_errors(value))
    if bool(errors) == fixture['valid']:
        raise AssertionError((fixture['file'], [e.message for e in errors]))

con = sqlite3.connect(':memory:')
con.executescript((BASE / 'sql/001-core.sql').read_text())
con.execute("INSERT INTO tasks VALUES ('task_1','test','active',1,1)")
con.execute("INSERT INTO runs (id,task_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run_1','task_1','running','epoch_1','{}','{}','now')")
try:
    con.execute("INSERT INTO runs (id,task_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run_2','task_1','waiting','epoch_1','{}','{}','now')")
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError('Multiple unfinished runs accepted')
con.execute("UPDATE runs SET state='completed',commit_valid=0 WHERE id='run_1'")
con.execute("INSERT INTO runs (id,task_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run_2','task_1','running','epoch_1','{}','{}','now')")
assert not con.execute('PRAGMA foreign_key_check').fetchall()
con.commit()
# Identical business payloads are separate records, not cached operations.
for i in (1, 2):
    con.execute('INSERT INTO records VALUES (?,?,?,?,?,?)',
                (f'event_{i}', 'task_1', i, 'answer.submitted', '{}', 'now'))
assert con.execute('SELECT count(*) FROM records').fetchone()[0] == 2
con.commit()
con.execute('BEGIN')
con.execute("UPDATE tasks SET revision=2 WHERE id='task_1'")
try:
    con.execute("INSERT INTO records VALUES ('event_bad','task_1',1,'test','{}','now')")
except sqlite3.IntegrityError:
    con.rollback()
else:
    raise AssertionError('Duplicate task sequence accepted')
assert con.execute("SELECT revision FROM tasks WHERE id='task_1'").fetchone()[0] == 1
con.execute("INSERT INTO recovery_points VALUES ('backup_1','valid','{}','now')")
try:
    con.execute("INSERT INTO recovery_points VALUES ('backup_2','valid','{}','now')")
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError('Multiple valid recovery points accepted')
con.close()

files = [ROOT / 'CONTEXT.md', *sorted((ROOT / 'docs').rglob('*.md')), *sorted((ROOT / '.agents/notes').rglob('*.md'))]
links = examples = 0
for path in files:
    text = path.read_text()
    assert len(re.findall(r'^```', text, re.M)) % 2 == 0, path
    for block in re.findall(r'^```json\s*\n(.*?)^```', text, re.M | re.S):
        json.loads(block)
        examples += 1
    for target in re.findall(r'\[[^\]]*\]\(([^\s)]+)\)', text):
        if re.match(r'^[A-Za-z]+:', target):
            continue
        links += 1
        filename, _, anchor = unquote(target).partition('#')
        dest = path.parent / filename if filename else path
        assert dest.exists(), (path, target)
        if anchor and dest.suffix == '.md':
            headings = re.findall(r'^#{1,6}\s+(.+?)\s*#*$', dest.read_text(), re.M)
            slugs = [re.sub(r'[^\w\-\s]', '', h.lower()).replace(' ', '-') for h in headings]
            assert anchor in slugs, (path, target)
for path in BASE.rglob('*.json'):
    json.loads(path.read_text())
print(f'PASS: {len(fixtures)} schema fixtures; in-memory SQL, unfinished-run/recovery uniqueness, independent submissions and rollback; {len(files)} Markdown files, {links} local links, {examples} fenced JSON examples')
print('Not tested: runtime behavior, DOM/CSS safety, model quality, native packaging or crash durability.')
