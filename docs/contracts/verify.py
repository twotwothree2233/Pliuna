#!/usr/bin/env python3
"""Validate current runtime contracts and code-linked project documentation."""
import json
import re
import runpy
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit('Missing jsonschema; install scripts/requirements-dev.txt.')

ROOT = Path(__file__).resolve().parents[2]
runpy.run_path(str(ROOT / 'scripts/verify-contracts.py'), run_name='__main__')
schema = json.loads((ROOT / 'src/shared/contracts/core.schema.json').read_text(encoding='utf-8'))
files = [ROOT / 'CONTEXT.md', *sorted((ROOT / 'docs').rglob('*.md'))]
links = examples = checked_examples = 0
for path in files:
    text = path.read_text(encoding='utf-8')
    assert len(re.findall(r'^```', text, re.M)) % 2 == 0, (path, 'Unclosed fence')
    for definition, block in re.findall(r'^```json(?:[ \t]+([a-z_0-9]+))?[ \t]*\n(.*?)^```[ \t]*$', text, re.M | re.S):
        try:
            value = json.loads(block)
        except json.JSONDecodeError as error:
            raise AssertionError((path, 'Invalid JSON example', str(error))) from error
        examples += 1
        if definition:
            assert definition in schema['$defs'], (path, definition)
            selected = {**schema, '$ref': '#/$defs/' + definition}
            errors = list(Draft202012Validator(selected).iter_errors(value))
            assert not errors, (path, definition, [error.message for error in errors])
            checked_examples += 1
    for target in re.findall(r'\[[^\]]*\]\(([^\s)]+)\)', text):
        url = urlsplit(target)
        if url.scheme or url.netloc:
            continue
        links += 1
        filename, anchor = unquote(url.path), unquote(url.fragment)
        destination = path.parent / filename if filename else path
        assert destination.exists(), (path, target)
        if anchor and destination.suffix == '.md':
            headings = re.findall(r'^#{1,6}\s+(.+?)\s*#*$', destination.read_text(encoding='utf-8'), re.M)
            slugs = [re.sub(r'[^\w\-\s]', '', heading.lower()).replace(' ', '-') for heading in headings]
            assert anchor in slugs, (path, target)
print(f'PASS: {len(files)} Markdown files; {links} local links; {examples} JSON examples, {checked_examples} checked against current schema')
