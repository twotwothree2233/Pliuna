import type { RequestAccounting } from '../model/accounting'
import { assertContract, ContractError } from '../../shared/validation'
import { RunnerBudgetLedger, type BudgetAmounts, type BudgetReservation } from './budget'
import { assertRunnerId } from './limits'

export interface RunnerBudgetAccountingScope {
  task_id: string
  budget_id: string
  attempt_id?: string
}
export type ToolAccountingPhase = RequestAccounting['phase']

function fail(code: string, message: string): never { throw new ContractError(code, message) }
function tokenTotal(input: number, output: number): number {
  const total = input + output
  if (![input, output, total].every(value => Number.isSafeInteger(value) && value >= 0)) fail('BUDGET_EVIDENCE_INVALID', 'Token evidence must contain nonnegative safe integers')
  return total
}

// The host qualifies new dispatch before calling this adapter. Terminal events
// are factual and remain settleable after cancellation or an epoch change.
export class RunnerBudgetAccounting {
  private readonly scope: Readonly<RunnerBudgetAccountingScope>

  constructor(private readonly ledger: RunnerBudgetLedger, scope: RunnerBudgetAccountingScope) {
    assertRunnerId(scope.task_id, 'task_id'); assertRunnerId(scope.budget_id, 'budget_id')
    if (scope.attempt_id !== undefined) assertRunnerId(scope.attempt_id, 'attempt_id')
    if (ledger.budget(scope.budget_id).task_id !== scope.task_id) fail('BUDGET_OWNER_MISMATCH', 'Accounting scope does not own this budget')
    this.scope = Object.freeze({ ...scope })
  }

  model(event: RequestAccounting): BudgetReservation {
    assertContract('request_accounting', event)
    assertRunnerId(event.request_id, 'request_id')
    const requested: BudgetAmounts = { model_requests: 1, tool_requests: 0, tokens: tokenTotal(event.estimated_input_tokens, event.output_reserve ?? 0) }
    if (event.phase === 'reserved') return this.reserve(event.request_id, requested)
    const reservation = this.bound(event.request_id, requested)
    if (event.phase === 'dispatched') return this.ledger.markDispatched(reservation.reservation_id)
    if (event.usage != null) {
      return this.ledger.settle(reservation.reservation_id, { tokens: tokenTotal(event.usage.prompt_tokens, event.usage.completion_tokens) })
    }
    if (event.phase === 'failed' && reservation.dispatched_at === null && ['reserved', 'released'].includes(reservation.state)) return this.ledger.releaseOnlyUndispatched(reservation.reservation_id)
    // Completion proves that a request ended, but an absent usage observation
    // cannot turn the reserved estimate into a fabricated actual token count.
    return this.ledger.markUnknown(reservation.reservation_id)
  }

  // operationId is a stable host operation identity, never a provider tool-call
  // ID that can be reused by a sibling attempt. Retain it for reconciliation.
  tool(operationId: string, phase: ToolAccountingPhase): BudgetReservation {
    assertRunnerId(operationId, 'operation_id')
    if (!['reserved', 'dispatched', 'completed', 'failed', 'unknown'].includes(phase)) fail('INVALID_REQUEST', 'Unknown tool accounting phase')
    const requested: BudgetAmounts = { model_requests: 0, tool_requests: 1, tokens: 0 }
    if (phase === 'reserved') return this.reserve(operationId, requested)
    const reservation = this.bound(operationId, requested)
    if (phase === 'dispatched') return this.ledger.markDispatched(reservation.reservation_id)
    if (phase === 'unknown') return this.ledger.markUnknown(reservation.reservation_id)
    if (phase === 'failed' && reservation.dispatched_at === null && ['reserved', 'released'].includes(reservation.state)) return this.ledger.releaseOnlyUndispatched(reservation.reservation_id)
    // Both a known success and a known dispatched failure consumed one tool
    // request. The tool's side-effect result is recorded by its original owner.
    return this.ledger.settle(reservation.reservation_id, { tokens: 0 })
  }

  private reserve(operationId: string, amounts: BudgetAmounts): BudgetReservation {
    return this.ledger.reserve(operationId, this.scope.budget_id, operationId, amounts, this.scope.attempt_id)
  }

  private bound(operationId: string, amounts: BudgetAmounts): BudgetReservation {
    const reservation = this.ledger.query(operationId)
    if (reservation.task_id !== this.scope.task_id || reservation.budget_id !== this.scope.budget_id || reservation.attempt_id !== (this.scope.attempt_id ?? null) || reservation.operation_id !== operationId) fail('BUDGET_OWNER_MISMATCH', 'Accounting event belongs to another operation owner')
    if (Object.keys(amounts).some(key => reservation.reserved[key as keyof BudgetAmounts] !== amounts[key as keyof BudgetAmounts])) fail('BUDGET_RESERVATION_CONFLICT', 'Accounting event changed the reserved operation amounts')
    return reservation
  }
}
