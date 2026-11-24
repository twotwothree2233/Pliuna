import type { TaskListItem } from '../../shared/types'
import { hostRequest } from './ModelSettings'

export interface TaskPage { items: TaskListItem[]; next_cursor: string | null }

export type TaskFilter = 'all' | 'review' | 'running' | 'archived'

export function readTaskPage(archived: boolean, name: string, cursor?: string, group: TaskFilter = 'all') {
  const query = name.trim()
  const status = group === 'review' || group === 'running' ? `workspace_${group}` : undefined
  return hostRequest<TaskPage>({ type: 'host.tasks.page', archived, input: {
    kind: 'task', limit: 50, ...(query || status ? { filters: { ...(query ? { name_query: query } : {}), ...(status ? { status } : {}) } } : {}), ...(cursor ? { cursor } : {})
  } })
}
