#!/usr/bin/env python3
"""Validate contract artifacts without touching a real application database."""
import json
import sqlite3
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit('Missing jsonschema; schema checks were NOT run.')

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'src/shared/contracts'
FIXTURES = ROOT / 'tests/fixtures/contracts'
schema = json.loads((BASE / 'core.schema.json').read_text())
Draft202012Validator.check_schema(schema)
fixtures = json.loads((FIXTURES / 'manifest.json').read_text())
for fixture in fixtures:
    selected = {**schema, '$ref': '#/$defs/' + fixture['definition']}
    value = json.loads((FIXTURES / fixture['file']).read_text())
    errors = list(Draft202012Validator(selected).iter_errors(value))
    if bool(errors) == fixture['valid']:
        raise AssertionError((fixture['file'], [e.message for e in errors]))

con = sqlite3.connect(':memory:')
con.executescript((BASE / '001-core.sql').read_text())
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

print(f'PASS: {len(fixtures)} schema fixtures; in-memory SQL, unfinished-run/recovery uniqueness, independent submissions and rollback')
print('Not tested: documentation, runtime behavior, DOM/CSS safety, model quality, native packaging or crash durability.')
