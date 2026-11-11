// Shared packaged process-host API. Keep the supervisor lookup relative to the
// application bundle, independent of the caller's cwd and installed tools.
export { startProcessTree, processEnvironment } from './process-tree'
export { PluginRpc } from '../runtime/plugins/rpc'
