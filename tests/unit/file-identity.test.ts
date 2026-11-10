import { expect,it } from 'vitest'
import { encodeFileIdentity,exactFileIdentity,journalFileIdentity,sameFileIdentity,sameJournalFileIdentity,validJournalFileIdentity,validStoredFileIdentity } from '../../src/platform/file-identity'

const exact = { dev: '2695480082', ino: '9007199256376705' }
const metadata = { size: 8, mtime: 1234.125, ctime: 5678.875, hash: 'a'.repeat(64) }
it('keeps the native large identity exact through the version 2 JSON round trip', () => {
  expect(exactFileIdentity({ dev: 2695480082n, ino: 9007199256376705n })).toEqual(exact)
  expect(JSON.parse(JSON.stringify(encodeFileIdentity(exact, 2)))).toEqual(exact)
  expect(validStoredFileIdentity(exact, 2)).toBe(true)
  expect(() => encodeFileIdentity(exact, 1)).toThrow('FILE_IDENTITY_UNSUPPORTED')
  expect(sameFileIdentity(exact, { ...exact, ino: '9007199256376704' })).toBe(false)
})
it('accepts only safe legacy integers, and compares safe old and exact forms equally', () => {
  const legacy = { dev: 12, ino: Number.MAX_SAFE_INTEGER }, decimal = { dev: '12', ino: String(Number.MAX_SAFE_INTEGER) }
  expect(encodeFileIdentity(decimal, 1)).toEqual(legacy)
  expect(validStoredFileIdentity(legacy, 1)).toBe(true)
  expect(sameFileIdentity(legacy, decimal)).toBe(true)
  expect(sameJournalFileIdentity({ ...legacy, ...metadata }, { ...decimal, ...metadata })).toBe(true)
  const lost = { dev: 2695480082, ino: 9007199256376704 }
  expect(validStoredFileIdentity(lost, 1)).toBe(false)
  expect(() => exactFileIdentity(lost)).toThrow('FILE_IDENTITY_UNSUPPORTED')
})
it.each(['', '00', '01', '-1', '+1', ' 1', '1 ', '1.0', '1e3', '0x12', '١', '18446744073709551616'])('rejects noncanonical or overflowing identity %j', ino => {
  expect(validStoredFileIdentity({ dev: '0', ino }, 2)).toBe(false)
})
it('enforces positive inode, u64 range, matching field types and version-specific types', () => {
  expect(validStoredFileIdentity({ dev: '0', ino: '18446744073709551615' }, 2)).toBe(true)
  for (const value of [{ dev: -1, ino: 1 }, { dev: 0, ino: 0 }, { dev: 1, ino: 1.5 }, { dev: 1, ino: NaN }, { dev: '0', ino: '0' }, { dev: '1', ino: 2 }, { dev: 1n, ino: 2 }]) {
    expect(() => exactFileIdentity(value)).toThrow('FILE_IDENTITY_UNSUPPORTED')
  }
  expect(validStoredFileIdentity({ dev: 1, ino: 2 }, 2)).toBe(false)
  expect(validStoredFileIdentity({ dev: '1', ino: '2' }, 1)).toBe(false)
})
it('preserves fractional timestamps, metadata and existing integrity fields', () => {
  const value = { ...exact, ...metadata }
  expect(journalFileIdentity(value, 2)).toEqual(value)
  expect(validJournalFileIdentity(value, 2)).toBe(true)
  for (const changed of [{ ...value, size: -1 }, { ...value, mtime: Infinity }, { ...value, hash: '' }, { ...value, extra: true }]) expect(validJournalFileIdentity(changed, 2)).toBe(false)
  expect(sameJournalFileIdentity(value, { ...value, ctime: metadata.ctime + 0.125 })).toBe(false)
})
