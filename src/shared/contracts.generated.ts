/* Generated from src/shared/contracts/core.schema.json. Do not edit. */
export interface Summary {
schema_version: "0.1"
coverage: {
snapshot_id: string
through_sequence: number
}
goals: SummarySummaryItem[]
constraints: SummarySummaryItem[]
completed: SummarySummaryItem[]
evidence: SummarySummaryItem[]
pending: SummarySummaryItem[]
uncertainties: SummarySummaryItem[]
}
export interface SummarySummaryItem {
text: string
sources: SummaryTarget[]
certainty: ("recorded" | "inferred" | "uncertain")
}
export interface SummaryTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary")
id: string
expected_revision?: number
}
export type SyncDeltaSyncChange = ({
type: "upsert"
target: SyncDeltaTarget
value: unknown
} | {
type: "remove"
target: SyncDeltaTarget
} | {
type: "invalidate"
target: SyncDeltaTarget
})

export interface SyncDelta {
runtime_epoch: string
task_id: string
sequence: number
/**
 * @minItems 1
 */
changes: [SyncDeltaSyncChange, ...(SyncDeltaSyncChange)[]]
}
export interface SyncDeltaTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary")
id: string
expected_revision?: number
}
export type BundleJsonPointer = string
export type BundleBehavior = ({
type: "input"
element_id: string
field: BundleJsonPointer
control: ("text" | "textarea" | "number" | "checkbox" | "radio" | "select" | "multiselect" | "range")
option_value?: unknown
} | {
type: "text"
element_id: string
field: BundleJsonPointer
} | {
type: "visible"
element_id: string
field: BundleJsonPointer
} | {
type: "toggle"
element_id: string
field: BundleJsonPointer
} | {
type: "class_toggle"
element_id: string
field: BundleJsonPointer
class_name: string
} | {
type: "submit"
element_id: string
form_id: string
})
/**
 * @maxItems 256
 */
export type BundleReferences = BundleReference[]

export interface Bundle {
profile: "managed-v1"
html: string
css: string
state: BundleState
forms: BundleForm[]
behaviors: BundleBehavior[]
references: BundleReferences
export: BundleExportFragment[]
}
export interface BundleState {
schema: BundleLocalSchema
initial: unknown
compatibility_version: string
}
export interface BundleLocalSchema {
type: ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")
description?: string
properties?: {
[k: string]: BundleLocalSchema
}
required?: string[]
additionalProperties?: false
items?: BundleLocalSchema
/**
 * @minItems 1
 */
enum?: [unknown, ...(unknown)[]]
minLength?: number
maxLength?: number
minItems?: number
maxItems?: number
minimum?: number
maximum?: number
}
export interface BundleForm {
id: string
/**
 * @minItems 1
 */
fields: [BundleJsonPointer, ...(BundleJsonPointer)[]]
}
export interface BundleReference {
name: string
target: BundleTarget
}
export interface BundleTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary")
id: string
expected_revision?: number
}
export interface BundleExportFragment {
id: string
category: ("learning" | "answer" | "feedback" | "mixed_personal" | "unclassified")
source: ({
type: "element"
element_id: string
} | {
type: "static"
html: string
css: string
})
evidence?: BundleTarget[]
personal_binding?: {
version: 1
answer_id: string
view_history_id: string
}
}
export type IpcRequest = ({
type: "task.create"
title: string
} | {
type: "task.snapshot"
task_id: string
} | {
type: "task.submit"
task_id: string
text: string
model_config_id: string
attachments: IpcRequestTarget[]
} | {
type: "task.stop"
task_id: string
} | {
type: "task.resume"
task_id: string
} | {
type: "task.delete"
task_id: string
invalidate_recovery_id?: string
} | {
type: "run.cancel"
task_id: string
run_id: string
} | {
type: "approval.decide"
task_id: string
approval_id: string
decision: ("approve" | "deny")
} | {
type: "draft.save"
task_id: string
view_id: string
view_revision: number
expected_state_revision: number
/**
 * @minItems 1
 */
fields: [{
path: IpcRequestJsonPointer
value: unknown
}, ...({
path: IpcRequestJsonPointer
value: unknown
})[]]
maintenance_token?: string
} | {
type: "answer.submit"
task_id: string
view_id: string
view_revision: number
expected_state_revision: number
form_id: string
} | {
type: "sync.subscribe"
task_id: string
after?: {
runtime_epoch: string
sequence: number
}
} | {
type: "operation.list"
task_id: string
limit: number
} | {
type: "cleanup.retry"
task_id: string
owner_id: string
} | {
type: "task.data.read"
task_id: string
id: string
expected_revision: number
} | {
type: "surface.respond"
task_id: string
action_id: string
proceed: boolean
confirm_discard: boolean
} | {
type: "task.query"
task_id: string
query: ({
type: "list"
input: IpcRequestList
} | {
type: "read"
input: IpcRequestRead
})
} | {
type: "host.tasks.page"
input: (IpcRequestList & {
kind?: "task"
})
} | {
type: "storage.status"
after?: number
} | {
type: "storage.retry"
job_id: string
} | {
type: "maintenance.status"
} | {
type: "maintenance.begin"
/**
 * @maxItems 256
 */
inputs?: {
task_id: string
view_id: string
}[]
} | {
type: "maintenance.cancel"
token: string
} | {
type: "maintenance.create"
token: string
inputs_saved: true
replace_id: (string | null)
} | {
type: "maintenance.restore"
token: string
point_id: string
database_sha256: string
inputs_saved: true
confirm_replace_newer_data: true
} | {
type: "maintenance.gc.status"
operation_id?: string
} | {
type: "maintenance.gc.preview"
token: string
inputs_saved: true
after?: number
} | {
type: "maintenance.gc.execute"
token: string
operation_id: string
inputs_saved: true
confirm_delete_orphans: true
} | {
type: "maintenance.gc.retry"
token: string
operation_id: string
inputs_saved: true
confirm_delete_orphans: true
} | {
type: "maintenance.gc.list"
before?: number
} | {
type: "maintenance.replica.list"
summary?: boolean
before?: number
} | {
type: "maintenance.replica.status"
operation_id: string
} | {
type: "maintenance.replica.preview"
token: string
inputs_saved: true
replica_id: string
} | {
type: "maintenance.replica.execute"
token: string
inputs_saved: true
operation_id: string
confirm_retire_replica: true
} | {
type: "maintenance.replica.retry"
token: string
inputs_saved: true
operation_id: string
confirm_retire_replica: true
} | {
type: "maintenance.resource.list"
before?: number
summary?: boolean
} | {
type: "maintenance.resource.status"
operation_id: string
} | {
type: "maintenance.resource.preview"
operation_id: string
token: string
inputs_saved: true
} | {
type: "maintenance.resource.execute"
operation_id: string
token: string
inputs_saved: true
confirm_retire_resource: true
} | {
type: "maintenance.resource.retry"
operation_id: string
token: string
inputs_saved: true
confirm_retire_resource: true
} | {
type: "storage.inspect.start"
scope: ("growth" | "resources" | "resource")
resource_id?: string
after?: number
} | {
type: "storage.inspect.status"
job_id: string
} | {
type: "storage.inspect.cancel"
job_id: string
} | {
type: "material.pick"
task_id: string
retry_of?: string
} | {
type: "material.text"
task_id: string
display_name: string
text: string
retry_of?: string
} | {
type: "material.list"
task_id: string
before?: number
} | {
type: "material.status"
task_id: string
operation_id: string
} | {
type: "material.cancel"
task_id: string
operation_id: string
} | {
type: "material.read"
task_id: string
resource_id: string
offset?: number
} | {
type: "material.internal.register"
task_id: string
/**
 * @minItems 1
 * @maxItems 50
 */
items: [{
display_name: string
source: ("file" | "text")
}, ...({
display_name: string
source: ("file" | "text")
})[]]
retry_of?: string
} | {
type: "material.internal.begin"
task_id: string
operation_id: string
byte_length: number
media_type: ("application/octet-stream" | "text/plain; charset=utf-8")
} | {
type: "material.internal.chunk"
task_id: string
operation_id: string
offset: number
data: string
} | {
type: "material.internal.finish"
task_id: string
operation_id: string
} | {
type: "material.internal.fail"
task_id: string
operation_id: string
code: ("IMPORT_SOURCE_UNAVAILABLE" | "IMPORT_SOURCE_CHANGED" | "IMPORT_TOO_LARGE" | "IMPORT_UNSAFE_SOURCE" | "IMPORT_TRANSFER_FAILED")
} | {
type: "request.submit"
task_id: string
text: string
model_config_id: string
/**
 * @maxItems 50
 */
resource_ids: string[]
/**
 * @maxItems 50
 */
import_ids: string[]
} | {
type: "request.list"
task_id: string
before?: number
} | {
type: "request.status"
task_id: string
request_id: string
} | {
type: "request.cancel"
task_id: string
request_id: string
} | {
type: "request.resolve"
task_id: string
request_id: string
model_config_id: string
use_successful: boolean
/**
 * @maxItems 50
 */
replacements: {
operation_id: string
new_operation_id: string
}[]
confirm: true
} | {
type: "context.status"
task_id: string
} | {
type: "context.compact"
task_id: string
model_config_id: string
confirm_cost: true
})
export type IpcRequestJsonPointer = string
export type IpcRequestRead = ({
[k: string]: unknown
} & {
target: IpcRequestTarget
range?: {
start_line: number
end_line: number
}
cursor?: string
content?: {
offset_bytes?: number
end_bytes?: number
pages?: {
start: number
end: number
}
max_chars?: number
}
})

export interface IpcRequestTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary")
id: string
expected_revision?: number
}
export interface IpcRequestList {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary")
filters?: {
name_query?: string
status?: string
since?: string
until?: string
}
limit?: number
cursor?: string
}
export type ModelRequest = ({
type: "list"
input: ModelRequestList
} | {
type: "read"
input: ModelRequestRead
} | {
type: "write"
input: ModelRequestWrite
} | {
type: "call"
input: ModelRequestCall
})
export type ModelRequestRead = ({
[k: string]: unknown
} & {
target: ModelRequestTarget
range?: {
start_line: number
end_line: number
}
cursor?: string
content?: {
offset_bytes?: number
end_bytes?: number
pages?: {
start: number
end: number
}
max_chars?: number
}
})
export type ModelRequestWrite = ({
type: "surface.update"
surface_id: string
expected_revision: number
/**
 * @minItems 1
 * @maxItems 100
 */
operations: [ModelRequestViewOp, ...(ModelRequestViewOp)[]]
/**
 * @maxItems 32
 */
snapshot_sources?: ModelRequestTarget[]
} | {
type: "task_data.create"
data: ModelRequestDataValue
} | {
type: "task_data.replace"
id: string
expected_revision: number
/**
 * Actual JSON value, preserving its type. Objects and arrays must not be encoded as strings. The task object's fixed local schema further constrains the value.
 */
value: ({
[k: string]: ModelRequestJsonValue
} | ModelRequestJsonValue[] | string | number | boolean | null)
references: ModelRequestReferences
} | {
type: "task_data.remove"
id: string
expected_revision: number
} | {
type: "resource.create"
display_name: string
content: ({
type: "text"
text: string
} | {
type: "json"
/**
 * Actual JSON value, preserving its type. Objects and arrays must not be encoded as strings. The task object's fixed local schema further constrains the value.
 */
value: ({
[k: string]: ModelRequestJsonValue
} | ModelRequestJsonValue[] | string | number | boolean | null)
})
})
export type ModelRequestViewOp = ({
type: "view.create"
client_ref: string
slot_id: string
bundle: ModelRequestBundleInput
} | {
type: "view.replace"
view_id: string
expected_view_revision: number
bundle: ModelRequestBundleInput
state_transition: ModelRequestStateTransition
} | {
type: "view.remove"
view_id: string
expected_view_revision: number
expected_state_revision: number
} | {
type: "layout.set"
layout: ModelRequestLayout
})
export type ModelRequestBundleInput = ({
type: "inline"
bundle: ModelRequestBundle
} | {
type: "resource"
resource: ModelRequestTarget
})
export type ModelRequestJsonPointer = string
export type ModelRequestBehavior = ({
type: "input"
element_id: string
field: ModelRequestJsonPointer
control: ("text" | "textarea" | "number" | "checkbox" | "radio" | "select" | "multiselect" | "range")
option_value?: unknown
} | {
type: "text"
element_id: string
field: ModelRequestJsonPointer
} | {
type: "visible"
element_id: string
field: ModelRequestJsonPointer
} | {
type: "toggle"
element_id: string
field: ModelRequestJsonPointer
} | {
type: "class_toggle"
element_id: string
field: ModelRequestJsonPointer
class_name: string
} | {
type: "submit"
element_id: string
form_id: string
})
/**
 * @maxItems 256
 */
export type ModelRequestReferences = ModelRequestReference[]
export type ModelRequestStateTransition = ({
type: "preserve"
expected_state_revision: number
compatibility_version: string
} | {
type: "reset"
expected_state_revision: number
initial: unknown
})
export type ModelRequestViewLocator = ({
type: "existing"
view_id: string
} | {
type: "created"
client_ref: string
})
/**
 * Actual JSON value, preserving its type. Objects and arrays must not be encoded as strings. The task object's fixed local schema further constrains the value.
 */
export type ModelRequestJsonValue = ({
[k: string]: ModelRequestJsonValue
} | ModelRequestJsonValue[] | string | number | boolean | null)

export interface ModelRequestList {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary")
filters?: {
name_query?: string
status?: string
since?: string
until?: string
}
limit?: number
cursor?: string
}
export interface ModelRequestTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary")
id: string
expected_revision?: number
}
export interface ModelRequestBundle {
profile: "managed-v1"
html: string
css: string
state: ModelRequestState
forms: ModelRequestForm[]
behaviors: ModelRequestBehavior[]
references: ModelRequestReferences
export: ModelRequestExportFragment[]
}
export interface ModelRequestState {
schema: ModelRequestLocalSchema
initial: unknown
compatibility_version: string
}
export interface ModelRequestLocalSchema {
type: ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")
description?: string
properties?: {
[k: string]: ModelRequestLocalSchema
}
required?: string[]
additionalProperties?: false
items?: ModelRequestLocalSchema
/**
 * @minItems 1
 */
enum?: [unknown, ...(unknown)[]]
minLength?: number
maxLength?: number
minItems?: number
maxItems?: number
minimum?: number
maximum?: number
}
export interface ModelRequestForm {
id: string
/**
 * @minItems 1
 */
fields: [ModelRequestJsonPointer, ...(ModelRequestJsonPointer)[]]
}
export interface ModelRequestReference {
name: string
target: ModelRequestTarget
}
export interface ModelRequestExportFragment {
id: string
category: ("learning" | "answer" | "feedback" | "mixed_personal" | "unclassified")
source: ({
type: "element"
element_id: string
} | {
type: "static"
html: string
css: string
})
evidence?: ModelRequestTarget[]
personal_binding?: {
version: 1
answer_id: string
view_history_id: string
}
}
export interface ModelRequestLayout {
slots: {
slot_id: string
groups: ModelRequestLayoutGroup[]
}[]
}
export interface ModelRequestLayoutGroup {
id: string
mode: ("column" | "responsive_columns")
views: ModelRequestViewLocator[]
/**
 * @minItems 1
 * @maxItems 6
 */
column_weights?: [number]|[number, number]|[number, number, number]|[number, number, number, number]|[number, number, number, number, number]|[number, number, number, number, number, number]
gap: ("none" | "small" | "medium" | "large")
align: ("start" | "center" | "stretch")
}
export interface ModelRequestDataValue {
schema: ModelRequestLocalSchema
/**
 * Actual JSON value matching schema. For an object schema pass an object such as {"stage":"initial"}, NOT a JSON-encoded string. Do not JSON.stringify this field. String values are valid only when the schema allows strings.
 */
value: ({
[k: string]: ModelRequestJsonValue
} | ModelRequestJsonValue[] | string | number | boolean | null)
references: ModelRequestReferences
}
export interface ModelRequestCall {
capability: string
arguments: ModelRequestJsonValue
references: ModelRequestReferences
}
export interface LocalSchema {
type: ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")
description?: string
properties?: {
[k: string]: LocalSchemaLocalSchema
}
required?: string[]
additionalProperties?: false
items?: LocalSchemaLocalSchema
/**
 * @minItems 1
 */
enum?: [unknown, ...(unknown)[]]
minLength?: number
maxLength?: number
minItems?: number
maxItems?: number
minimum?: number
maximum?: number
}
export interface LocalSchemaLocalSchema {
type: ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")
description?: string
properties?: {
[k: string]: LocalSchemaLocalSchema
}
required?: string[]
additionalProperties?: false
items?: LocalSchemaLocalSchema
/**
 * @minItems 1
 */
enum?: [unknown, ...(unknown)[]]
minLength?: number
maxLength?: number
minItems?: number
maxItems?: number
minimum?: number
maximum?: number
}
export interface ModelConfiguration {
id: string
base_url: string
wire_model_id: string
context_tokens: number
max_output_tokens?: number
compatibility_profile: ("chat-max-tokens" | "chat-max-completion-tokens")
metadata?: ModelConfigurationModelMetadata
compaction_model_id?: string
compaction_target?: {
id: string
revision: number
base_url: string
}
limits?: {
request_timeout_ms?: number
response_bytes?: number
run_tokens?: number
run_model_requests?: number
run_tool_requests?: number
run_wall_ms?: number
}
}
export interface ModelConfigurationModelMetadata {
context_tokens: ModelConfigurationModelFieldOrigin
max_output_tokens: ModelConfigurationModelFieldOrigin
provider_id?: string
capabilities: {
tools: ("unknown" | "supported" | "unsupported")
streaming: ("unknown" | "supported" | "unsupported")
vision: ("unknown" | "supported" | "unsupported")
structured_output: ("unknown" | "supported" | "unsupported")
}
}
export interface ModelConfigurationModelFieldOrigin {
source: ("manual" | "service" | "models.dev" | "legacy")
fetched_at: (string | null)
manual_override: boolean
}
export type HostModelRequest = ({
type: "model.list"
} | {
type: "model.configure"
configuration: HostModelRequestModelConfiguration
api_key: string
confirm_memory_only: true
remember_connection?: boolean
confirm_secure_storage?: true
confirm_plaintext_storage?: true
use_saved_credential?: boolean
confirm_history_processing?: true
} | {
type: "model.test"
model_id: string
role: ("main" | "approval" | "compaction")
confirm_cost: true
operation_id?: string
} | {
type: "model.remove"
model_id: string
} | {
type: "model.discover"
model_id: string
operation_id?: string
include_metadata?: boolean
} | {
type: "approval.configure"
mode: ("manual" | "assisted")
model_id: string
confirm_external_processing: boolean
} | {
type: "model.probe"
operation_id: string
base_url: string
api_key: string
confirm_memory_only: true
include_metadata?: boolean
} | {
type: "model.cancel"
operation_id: string
} | {
type: "model.remember"
model_id: string
confirm: true
} | {
type: "model.credential.delete"
model_id: string
confirm: true
})

export interface HostModelRequestModelConfiguration {
id: string
base_url: string
wire_model_id: string
context_tokens: number
max_output_tokens?: number
compatibility_profile: ("chat-max-tokens" | "chat-max-completion-tokens")
metadata?: HostModelRequestModelMetadata
compaction_model_id?: string
compaction_target?: {
id: string
revision: number
base_url: string
}
limits?: {
request_timeout_ms?: number
response_bytes?: number
run_tokens?: number
run_model_requests?: number
run_tool_requests?: number
run_wall_ms?: number
}
}
export interface HostModelRequestModelMetadata {
context_tokens: HostModelRequestModelFieldOrigin
max_output_tokens: HostModelRequestModelFieldOrigin
provider_id?: string
capabilities: {
tools: ("unknown" | "supported" | "unsupported")
streaming: ("unknown" | "supported" | "unsupported")
vision: ("unknown" | "supported" | "unsupported")
structured_output: ("unknown" | "supported" | "unsupported")
}
}
export interface HostModelRequestModelFieldOrigin {
source: ("manual" | "service" | "models.dev" | "legacy")
fetched_at: (string | null)
manual_override: boolean
}
export type HostPluginRequest = ({
type: "plugin.list"
task_id: string
before?: number
} | {
type: "plugin.pick"
} | {
type: "plugin.internal.install"
source: string
} | {
type: "plugin.trust"
digest: string
confirm_local_code: true
confirm_cross_task: boolean
} | {
type: "plugin.revoke"
digest: string
} | {
type: "plugin.plan"
task_id: string
digest: string
/**
 * @maxItems 64
 */
choices?: string[]
} | {
type: "plugin.enable"
task_id: string
digest: string
/**
 * @maxItems 64
 */
choices?: string[]
fingerprint: string
confirm_cross_task: boolean
} | {
type: "plugin.disable"
digest: string
task_id: (string | null)
} | {
type: "plugin.workflow"
task_id: string
selection: (null | {
digest: string
contribution_id: string
})
} | {
type: "plugin.content"
task_id: string
digest: string
contribution_id: string
offset?: number
})
