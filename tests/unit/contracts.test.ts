import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertContract } from '../../src/shared/validation'
const base = 'tests/fixtures/contracts/'
const fixtures = JSON.parse(readFileSync(base + 'manifest.json', 'utf8')) as { file: string; definition: string; valid: boolean }[]
describe('canonical schema fixtures (Ajv 2020-12)', () => {
  for (const f of fixtures) it(`${f.file}: ${f.valid ? 'accept' : 'reject'}`, () => {
    const check = () => assertContract(f.definition, JSON.parse(readFileSync(base + f.file, 'utf8')))
    if (f.valid) expect(check).not.toThrow(); else expect(check).toThrow()
  })
})
