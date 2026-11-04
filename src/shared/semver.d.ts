declare module 'semver' {
  const semver: { validRange(range: string): string | null; satisfies(version: string, range: string): boolean }
  export default semver
}
