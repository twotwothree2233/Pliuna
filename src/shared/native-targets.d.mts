export interface MontyTarget {
  id: string
  platform: string
  arch: string
  libc: string | null
  package: string
  binary: string
  native: string
  runtimeVerified: boolean
  integrity: { binary: string; native: string } | null
}
export const nativeTargets: { montyPackage: string; montyVersion: string; targets: MontyTarget[] }
export function montyTarget(platform: string, arch: string, libc?: string | null): MontyTarget | null
export function hostMontyTarget(): MontyTarget | null
