import { applicationEnvironment } from '../shared/branding'
// Isolated tool and admission fixtures can opt into single-production runs.
export const productionRunsPerTask = 1
export function runtimeFeatures(env: NodeJS.ProcessEnv): { viewReplacement: boolean; monty: boolean; runner?: { productionRuns: 1 | 2; collator: 'rule' | 'model'; conversationRouting?: boolean } } {
  // Release features still pass the original authorization and asset gates.
  const testRunner = applicationEnvironment(env, 'TEST_RUNNER')
  const runner = testRunner === undefined
    ? { productionRuns: 2 as const, collator: 'model' as const, conversationRouting: true }
    : ['single', 'dual'].includes(testRunner)
      ? { productionRuns: testRunner === 'dual' ? 2 as const : 1 as const, collator: applicationEnvironment(env, 'TEST_RUNNER_COLLATOR') === 'model' ? 'model' as const : 'rule' as const }
      : undefined
  return { monty: applicationEnvironment(env, 'ENABLE_MONTY') !== '0', viewReplacement: applicationEnvironment(env, 'ENABLE_VIEW_REPLACEMENT') !== '0', ...(runner ? { runner } : {}) }
}
