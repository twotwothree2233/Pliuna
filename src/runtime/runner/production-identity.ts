import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import identitySql from '../../shared/contracts/005-production-identity.sql?raw'
import { ContractError } from '../../shared/validation'
import { canonical } from '../surface-transition'
import { materializeProducerDraft, validateProducerResult, type ProducerDraft, type ProducerResult, type ProductionResultBinding } from './production-profile'

export function installProductionIdentitySchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(identitySql)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_upgrade_state'").get()) {
      for (const table of ['runner_artifact_slots', 'runner_production_submissions']) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS business_v2_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE business_upgrade_state SET v2_writes=1 WHERE id=1 AND v2_writes=0; END`)
      }
    }
  })()
}

// A slot identifies one logical output across attempts. A response identifies one
// immutable submission, so correcting a draft never reuses a rejected candidate.
export function bindProductionIdentities(db: Database.Database, draft: ProducerDraft, source: ProductionResultBinding, responseRecordId: string): ProducerResult {
  return db.transaction(() => {
    const previous = db.prepare('SELECT task_id,work_id,attempt_id,draft_json,result_json FROM runner_production_submissions WHERE response_record_id=?').get(responseRecordId) as { task_id: string; work_id: string; attempt_id: string; draft_json: string; result_json: string } | undefined
    if (previous) {
      if (previous.task_id !== source.owner.task_id || previous.work_id !== source.owner.work_id || previous.attempt_id !== source.owner.attempt_id || previous.draft_json !== canonical(draft)) throw new ContractError('RUNNER_OUTPUT_CONFLICT', 'A response retains its original draft and formal identities')
      return validateProducerResult(JSON.parse(previous.result_json), source)
    }
    const identities = draft.artifacts.map(artifact => {
      let artifactId = artifact.artifact_id
      if (artifact.output_key !== undefined) {
        const slot = db.prepare('SELECT task_id,artifact_id FROM runner_artifact_slots WHERE work_id=? AND output_key=?').get(source.work.work_id, artifact.output_key) as { task_id: string; artifact_id: string } | undefined
        if (slot && slot.task_id !== source.owner.task_id) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'An output slot belongs to its original Task')
        artifactId = slot?.artifact_id ?? randomUUID()
        if (!slot) db.prepare('INSERT INTO runner_artifact_slots(work_id,output_key,task_id,artifact_id) VALUES (?,?,?,?)').run(source.work.work_id, artifact.output_key, source.owner.task_id, artifactId)
      }
      return { artifact_id: artifactId!, candidate_id: randomUUID() }
    })
    const result = materializeProducerDraft(draft, source, identities)
    db.prepare('INSERT INTO runner_production_submissions(response_record_id,task_id,work_id,attempt_id,draft_json,result_json) VALUES (?,?,?,?,?,?)').run(responseRecordId, source.owner.task_id, source.owner.work_id, source.owner.attempt_id, canonical(draft), canonical(result))
    return result
  }).immediate()
}
