import { applicationEnvironment } from '../shared/branding'
export function runtimeFeatures(env: NodeJS.ProcessEnv): { viewReplacement: boolean; monty: boolean } {
  // Release features still pass the original authorization and asset gates.
  return { monty: applicationEnvironment(env, 'ENABLE_MONTY') !== '0', viewReplacement: applicationEnvironment(env, 'ENABLE_VIEW_REPLACEMENT') !== '0' }
}
