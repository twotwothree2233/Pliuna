import { ContractError } from '../../shared/validation'

export function readPermission(waitReason?: string | null) {
  return { scope: 'current-task', separate_approval: false, dispatch: ['approval', 'surface_host'].includes(waitReason ?? '') ? 'blocked_waiting' : 'available', object_checks: 'required', user_intent: 'not_inferred' } as const
}

// Existing dispatch wait, not an extra approval or an object access grant.
export function assertReadDispatch(waitReason?: string | null): void {
  if (readPermission(waitReason).dispatch === 'blocked_waiting') throw new ContractError('SOURCE_WAITING', 'Awaiting approval or host check; only control/read host operations are available')
}
