import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The packaging command must also be importable without copying or launching an app.
// @ts-expect-error Build tooling is a standalone JavaScript module.
import { assertNewOutput, assertCleanPayload, fileManifest, productionPackages, readGuide, copyGuide, sourceManifest, parsePackageArgs } from '../../scripts/package-macos.mjs'
// @ts-expect-error Build tooling is a standalone JavaScript module.
import { verifyManifest } from '../../scripts/verify-package.mjs'

it('packages without repository documents and includes only an explicit guide snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-package-guide-')), guide = join(root, 'external-guide.txt'), output = join(root, 'output')
  mkdirSync(output)
  copyGuide(output, readGuide(undefined))
  expect(existsSync(join(output, '使用指南.md'))).toBe(false)
  writeFileSync(guide, 'explicit external guide')
  const captured = readGuide(guide)
  writeFileSync(guide, 'changed after capture')
  copyGuide(output, captured)
  expect(readFileSync(join(output, '使用指南.md'), 'utf8')).toBe('explicit external guide')
  expect(() => copyGuide(output, captured)).toThrow()
  expect(() => readGuide(join(root, 'missing'))).toThrow()
  expect(() => readGuide(root)).toThrow('regular file')
  expect(() => readGuide('relative-guide.txt')).toThrow('absolute')
  symlinkSync(guide, join(root, 'link'))
  expect(() => readGuide(join(root, 'link'))).toThrow('regular file')
})

it('accepts only explicit output and optional external guide arguments', () => {
  const output = join(tmpdir(), 'new', 'candidate'), guide = join(tmpdir(), 'external', 'guide')
  expect(parsePackageArgs(['--output', output])).toEqual({ output, guide: undefined })
  expect(parsePackageArgs(['--output', output, '--guide', guide])).toEqual({ output, guide })
  for (const args of [[], ['--output', 'relative'], ['--output', output, '--guide', 'relative'], ['--output', output, '--unknown', guide], ['--output', output, '--guide']]) expect(() => parsePackageArgs(args)).toThrow('Usage')
})

it('records runtime assets but does not enumerate repository prose', () => {
  const files = sourceManifest(process.cwd()).map((entry: { path: string }) => entry.path)
  expect(files).toEqual(expect.arrayContaining(['src/shared/contracts/core.schema.json', 'src/shared/contracts/001-core.sql', 'src/shared/contracts/development-defaults.json', 'src/runtime/model/prompts/agent-v0.1.txt', 'reference-plugins/pdf-text/vendor/LICENSE']))
  expect(files.some((path: string) => path.startsWith('docs/') || path.startsWith('.agents/') || path.endsWith('.md'))).toBe(false)
})

it('refuses existing outputs, zip siblings, dangling links and workspace destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-package-guards-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  expect(assertNewOutput(join(root, 'new'), workspace)).toBe(join(root, 'new'))
  expect(() => assertNewOutput(join(workspace, 'build'), workspace)).toThrow('outside')
  mkdirSync(join(root, 'existing'))
  expect(() => assertNewOutput(join(root, 'existing'), workspace)).toThrow('exists')
  writeFileSync(join(root, 'zip.zip'), '')
  expect(() => assertNewOutput(join(root, 'zip'), workspace)).toThrow('exists')
  symlinkSync(join(root, 'missing'), join(root, 'dangling'))
  expect(() => assertNewOutput(join(root, 'dangling'), workspace)).toThrow('exists')
  symlinkSync(workspace, join(root, 'workspace-link'))
  expect(() => assertNewOutput(join(root, 'workspace-link/new'), workspace)).toThrow('outside')
})

it('records exact bytes and relative links and rejects external links', () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-package-manifest-'))
  writeFileSync(join(root, 'file'), 'abc')
  symlinkSync('file', join(root, 'link'))
  expect(fileManifest(root)).toEqual([
    expect.objectContaining({ path: 'file', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }),
    { path: 'link', link: 'file' }
  ])
  symlinkSync(tmpdir(), join(root, 'outside'))
  expect(() => fileManifest(root)).toThrow('Escaping')
})

it('rejects credentials, local databases and old acceptance wrappers', () => {
  for (const path of ['app/auth.json', 'settings.json', 'app/.env', 'data/runtime.sqlite-wal', 'app/synthetic-sample/file', 'app/acceptance.mjs']) {
    expect(() => assertCleanPayload([{ path }])).toThrow('payload rejected')
  }
  expect(() => assertCleanPayload([{ path: 'app/out/main/index.js' }])).not.toThrow()
})

it('resolves the real production closure with only the approved native platform', () => {
  const packages = productionPackages(process.cwd())
  const names = packages.map((pkg: { name: string }) => pkg.name)
  expect(names).toEqual(expect.arrayContaining(['better-sqlite3', 'bindings', '@pydantic/monty', '@pydantic/monty-darwin-arm64', 'react-dom', 'scheduler']))
  expect(names.filter((name: string) => name.startsWith('@pydantic/monty-'))).toEqual(['@pydantic/monty-darwin-arm64'])
  expect(names).not.toContain('prebuild-install')
  expect(names).not.toContain('electron')
})

it('rejects changed bytes and extra files in a completed package', () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-package-verify-'))
  writeFileSync(join(root, 'file'), 'before')
  writeFileSync(join(root, 'FILES.json'), JSON.stringify(fileManifest(root)))
  expect(verifyManifest(root)).toBe(1)
  writeFileSync(join(root, 'file'), 'after')
  expect(() => verifyManifest(root)).toThrow('mismatch')
  writeFileSync(join(root, 'file'), 'before')
  writeFileSync(join(root, 'extra'), 'extra')
  expect(() => verifyManifest(root)).toThrow('mismatch')
})
