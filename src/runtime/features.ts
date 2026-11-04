export function runtimeFeatures(env: NodeJS.ProcessEnv): { viewReplacement: boolean; monty: boolean } {
  // Release features still pass the original authorization and asset gates.
  return { monty: env.TRELLIS_ENABLE_MONTY !== '0', viewReplacement: env.TRELLIS_ENABLE_VIEW_REPLACEMENT !== '0' }
}
