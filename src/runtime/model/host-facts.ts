export const persistenceFacts = {
  storage: 'local-task-store',
  saved_records: ['accepted-messages', 'submitted-answers', 'tool-records', 'installed-summaries'],
  compaction_deletes_originals: false,
  restart_resumes_execution: false
} as const
