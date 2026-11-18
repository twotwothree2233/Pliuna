import type Database from 'better-sqlite3'
import { ContractError } from '../../shared/validation'
import { assertRunnerId } from './limits'

export interface BudgetAmounts { model_requests: number; tool_requests: number; tokens: number }
export interface RunnerBudgetLimits extends BudgetAmounts { wall_ms: number }
export interface RunnerBudget {
  budget_id: string; task_id: string; purpose: 'production' | 'composition'; request_id: string | null
  created_at: string
}
export interface BudgetReservation {
  reservation_id: string; task_id: string; budget_id: string; attempt_id: string | null; operation_id: string
  state: 'reserved' | 'settled' | 'released' | 'unknown'; reserved: BudgetAmounts; usage: BudgetAmounts | null
  created_at: string; dispatched_at: string | null; settled_at: string | null
}
export interface BudgetSnapshot {
  budget: RunnerBudget; settled: BudgetAmounts; reserved: BudgetAmounts; unknown: BudgetAmounts
  total: BudgetAmounts
}
type BudgetInput = Omit<RunnerBudget, 'created_at'> & { limits?: RunnerBudgetLimits }
type BudgetRow = RunnerBudget & { limits_json: string }
type ReservationRow = Omit<BudgetReservation, 'reserved' | 'usage'> & { reserved_json: string; usage_json: string | null }
const amountKeys = ['model_requests', 'tool_requests', 'tokens'] as const
const zero = (): BudgetAmounts => ({ model_requests: 0, tool_requests: 0, tokens: 0 })
function fail(code: string, message: string): never { throw new ContractError(code, message) }

function amounts(value: Partial<BudgetAmounts>): BudgetAmounts {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !amountKeys.includes(key as typeof amountKeys[number]))) fail('INVALID_REQUEST', 'Invalid budget amount fields')
  const result = { ...zero(), ...value }
  if (amountKeys.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0)) fail('INVALID_REQUEST', 'Budget amounts must be nonnegative safe integers')
  return result
}
function add(target: BudgetAmounts, value: BudgetAmounts): void {
  for (const key of amountKeys) {
    target[key] += value[key]
    if (!Number.isSafeInteger(target[key])) fail('BUDGET_EVIDENCE_INVALID', 'Cumulative budget evidence exceeds safe integer capacity')
  }
}
function budgetValue(row: BudgetRow): RunnerBudget {
  const { limits_json, ...identity } = row
  return identity
}
function reservationValue(row: ReservationRow): BudgetReservation {
  const { reserved_json, usage_json, ...identity } = row
  return { ...identity, reserved: amounts(JSON.parse(reserved_json)), usage: usage_json === null ? null : amounts(JSON.parse(usage_json)) }
}

// A budget belongs to a goal or one composition opportunity, not to a Worker or
// Run. IMMEDIATE transactions preserve operation identities across independent
// connections; usage and unknown reservations are facts, without cumulative caps.
export class RunnerBudgetLedger {
  constructor(private readonly db: Database.Database, private readonly clock: () => number = Date.now) {}

  create(input: BudgetInput): RunnerBudget {
    const { budget_id, task_id, purpose, request_id } = input
    assertRunnerId(budget_id, 'budget_id'); assertRunnerId(task_id, 'task_id')
    if (purpose !== 'production' && purpose !== 'composition') fail('INVALID_REQUEST', 'Unknown runner budget purpose')
    if (purpose === 'production') assertRunnerId(request_id, 'request_id')
    else if (request_id !== null) fail('INVALID_REQUEST', 'Composition budgets cannot own a business goal')
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM runner_budgets WHERE budget_id=?').get(budget_id) as BudgetRow | undefined
      if (existing) {
        const value = budgetValue(existing)
        if (value.task_id !== task_id || value.purpose !== purpose || value.request_id !== request_id) fail('BUDGET_ID_CONFLICT', 'An existing budget cannot change ownership')
        return value
      }
      if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(task_id)) fail('BUDGET_OWNER_MISMATCH', 'Budget Task does not exist')
      if (purpose === 'production') {
        if (!this.db.prepare('SELECT id FROM requests WHERE id=? AND task_id=?').get(request_id, task_id)) fail('BUDGET_OWNER_MISMATCH', 'Budget request does not belong to this Task')
        if (this.db.prepare("SELECT budget_id FROM runner_budgets WHERE request_id=? AND purpose='production'").get(request_id)) fail('BUDGET_ID_CONFLICT', 'The goal already owns a cumulative production budget')
      }
      const created_at = new Date(this.clock()).toISOString()
      this.db.prepare('INSERT INTO runner_budgets(budget_id,task_id,purpose,request_id,limits_json,created_at) VALUES (?,?,?,?,?,?)').run(budget_id, task_id, purpose, request_id, '{}', created_at)
      return { budget_id, task_id, purpose, request_id, created_at }
    }).immediate()
  }

  budget(budgetId: string): RunnerBudget {
    const row = this.db.prepare('SELECT * FROM runner_budgets WHERE budget_id=?').get(budgetId) as BudgetRow | undefined
    if (!row) fail('BUDGET_NOT_FOUND', 'Runner budget does not exist')
    return budgetValue(row)
  }

  query(reservationId: string): BudgetReservation {
    const row = this.db.prepare('SELECT * FROM runner_budget_reservations WHERE reservation_id=?').get(reservationId) as ReservationRow | undefined
    if (!row) fail('BUDGET_RESERVATION_NOT_FOUND', 'Budget reservation does not exist')
    return reservationValue(row)
  }

  snapshot(budgetId: string): BudgetSnapshot {
    const budget = this.budget(budgetId), settled = zero(), reserved = zero(), unknown = zero()
    const rows = this.db.prepare('SELECT * FROM runner_budget_reservations WHERE budget_id=?').all(budgetId) as ReservationRow[]
    for (const row of rows) {
      const value = reservationValue(row)
      if (value.state === 'settled') {
        if (!value.usage) fail('BUDGET_EVIDENCE_INVALID', 'Settled budget reservation has no usage evidence')
        add(settled, value.usage)
      } else if (value.state === 'reserved') add(reserved, value.reserved)
      else if (value.state === 'unknown') add(unknown, value.reserved)
    }
    const total = zero(); add(total, settled); add(total, reserved); add(total, unknown)
    return { budget, settled, reserved, unknown, total }
  }

  reserve(reservationId: string, budgetId: string, operationId: string, requested: Partial<BudgetAmounts>, attemptId?: string): BudgetReservation {
    assertRunnerId(reservationId, 'reservation_id'); assertRunnerId(budgetId, 'budget_id'); assertRunnerId(operationId, 'operation_id')
    if (attemptId !== undefined) assertRunnerId(attemptId, 'attempt_id')
    const checked = amounts(requested)
    if (amountKeys.every(key => checked[key] === 0)) fail('INVALID_REQUEST', 'A reservation must reserve a budget unit')
    return this.db.transaction(() => {
      const identity = this.db.prepare('SELECT * FROM runner_budget_reservations WHERE reservation_id=?').get(reservationId) as ReservationRow | undefined
      const operation = this.db.prepare('SELECT * FROM runner_budget_reservations WHERE budget_id=? AND operation_id=?').get(budgetId, operationId) as ReservationRow | undefined
      if (identity && (identity.budget_id !== budgetId || identity.operation_id !== operationId)) fail('BUDGET_RESERVATION_CONFLICT', 'Reservation identity is bound to another operation')
      const existing = identity ?? operation
      if (existing) {
        const value = reservationValue(existing)
        if (value.attempt_id !== (attemptId ?? null) || JSON.stringify(value.reserved) !== JSON.stringify(checked)) fail('BUDGET_RESERVATION_CONFLICT', 'A reserved operation cannot change its amounts or attempt')
        return value
      }
      const budget = this.budget(budgetId)
      if (attemptId !== undefined && !this.db.prepare('SELECT a.attempt_id FROM runner_attempts a JOIN runner_runs r ON r.run_id=a.run_id WHERE a.attempt_id=? AND a.task_id=? AND r.budget_id=?').get(attemptId, budget.task_id, budgetId)) fail('BUDGET_OWNER_MISMATCH', 'Attempt does not belong to this budget')
      const created_at = new Date(this.clock()).toISOString()
      this.db.prepare("INSERT INTO runner_budget_reservations(reservation_id,task_id,budget_id,attempt_id,operation_id,state,reserved_json,usage_json,created_at,dispatched_at,settled_at) VALUES (?,?,?,?,?,'reserved',?,NULL,?,NULL,NULL)").run(reservationId, budget.task_id, budgetId, attemptId ?? null, operationId, JSON.stringify(checked), created_at)
      return this.query(reservationId)
    }).immediate()
  }

  // Persist the barrier before sending anything externally. A crash after this
  // point requires reconciliation; elapsed time cannot justify releasing it.
  markDispatched(reservationId: string): BudgetReservation {
    return this.db.transaction(() => {
      const reservation = this.query(reservationId)
      if (reservation.state !== 'reserved') fail('BUDGET_RESERVATION_NOT_ACTIVE', 'Only an active reserved operation may dispatch')
      if (reservation.dispatched_at === null) this.db.prepare('UPDATE runner_budget_reservations SET dispatched_at=? WHERE reservation_id=?').run(new Date(this.clock()).toISOString(), reservationId)
      return this.query(reservationId)
    }).immediate()
  }

  markUnknown(reservationId: string): BudgetReservation {
    return this.db.transaction(() => {
      const reservation = this.query(reservationId)
      if (reservation.state === 'released') fail('BUDGET_RESERVATION_RELEASED', 'A definitely undispatched reservation was already released')
      if (reservation.state === 'reserved') this.db.prepare("UPDATE runner_budget_reservations SET state='unknown',dispatched_at=COALESCE(dispatched_at,?) WHERE reservation_id=?").run(new Date(this.clock()).toISOString(), reservationId)
      return this.query(reservationId)
    }).immediate()
  }

  settle(reservationId: string, actual: Partial<BudgetAmounts> & { tokens: number }): BudgetReservation {
    if (!actual || !Object.hasOwn(actual, 'tokens')) fail('INVALID_REQUEST', 'Settlement requires an explicit token usage observation')
    return this.db.transaction(() => {
      const reservation = this.query(reservationId)
      const checked = amounts({ ...reservation.reserved, ...actual })
      if (checked.model_requests !== reservation.reserved.model_requests || checked.tool_requests !== reservation.reserved.tool_requests) fail('BUDGET_USAGE_CONFLICT', 'Settlement cannot erase or add reserved request counts')
      if (reservation.state === 'released') fail('BUDGET_RESERVATION_RELEASED', 'A released operation cannot acquire usage')
      if (reservation.state === 'settled') {
        if (JSON.stringify(checked) !== JSON.stringify(reservation.usage)) fail('BUDGET_USAGE_CONFLICT', 'An operation already has different settled usage')
        return reservation
      }
      this.db.prepare("UPDATE runner_budget_reservations SET state='settled',usage_json=?,settled_at=? WHERE reservation_id=?").run(JSON.stringify(checked), new Date(this.clock()).toISOString(), reservationId)
      return this.query(reservationId)
    }).immediate()
  }

  releaseOnlyUndispatched(reservationId: string): BudgetReservation {
    return this.db.transaction(() => {
      const reservation = this.query(reservationId)
      if (reservation.state === 'released') return reservation
      if (reservation.state !== 'reserved' || reservation.dispatched_at !== null) fail('BUDGET_RECONCILIATION_REQUIRED', 'A possibly dispatched operation must be reconciled before releasing usage')
      this.db.prepare("UPDATE runner_budget_reservations SET state='released',settled_at=? WHERE reservation_id=?").run(new Date(this.clock()).toISOString(), reservationId)
      return this.query(reservationId)
    }).immediate()
  }
}
