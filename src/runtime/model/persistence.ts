import type { ModelConfiguration } from '../../shared/contracts.generated'
import type { VaultLoad } from '../../main/secure-model-store'
export interface SavedConnection {
  configuration: ModelConfiguration
  key: string | null
  revision: number
  protocol: string
  roles: ('main' | 'approval' | 'compaction')[]
}
export interface ModelPersistence {
  load(): Promise<VaultLoad>
  save(records: SavedConnection[]): Promise<void>
}
