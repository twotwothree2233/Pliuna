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
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
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
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
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
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
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
authorization_id?: string
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
type: "maintenance.replica.reauthorize.preview"
token: string
operation_id: string
inputs_saved: true
} | {
type: "maintenance.replica.reauthorize.confirm"
token: string
operation_id: string
authorization_id: string
inputs_saved: true
confirm_reauthorize_replica: true
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
} | {
type: "chapters.map"
task_id: IpcRequestRunnerId
view_id: IpcRequestRunnerId
expected_view_revision: number
} | {
type: "chapter.update"
source_request_id?: IpcRequestRunnerId
task_id: IpcRequestRunnerId
input_event_id: IpcRequestRunnerId
update_id: IpcRequestRunnerId
view_id: IpcRequestRunnerId
view_revision: number
state_revision: number
/**
 * @minItems 1
 * @maxItems 256
 */
region_ids: string[]
text: string
model_config_id: IpcRequestRunnerId
/**
 * @minItems 1
 * @maxItems 256
 */
tree_operations?: ContentOperationPlan[]
} | {
type: "chapter.cancel"
task_id: IpcRequestRunnerId
update_id: IpcRequestRunnerId
} | {
type: "chapter.status"
task_id: IpcRequestRunnerId
update_id: IpcRequestRunnerId
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
export type IpcRequestRunnerId = string

export interface IpcRequestTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
id: string
expected_revision?: number
}
export interface IpcRequestList {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
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
input: ModelRequestModelRead
} | {
type: "write"
input: ModelRequestWrite
} | {
type: "call"
input: ModelRequestCall
})
export type ModelRequestModelRead = ({
[k: string]: unknown
} & {
target: ModelRequestModelTarget
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
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
filters?: {
name_query?: string
status?: string
since?: string
until?: string
}
limit?: number
cursor?: string
}
export interface ModelRequestModelTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "runner_outline" | "runner_batch" | "runner_artifact_index" | "runner_layout" | "content_tree" | "content_node")
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
export interface ModelRequestTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
id: string
expected_revision?: number
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
}
channel_id?: string
display_name?: string
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
} | {
type: "model.channel.configure"
channel: {
id: string
name: string
base_url: string
compatibility_profile: ("chat-max-tokens" | "chat-max-completion-tokens")
}
api_key: string
use_saved_credential?: boolean
remember_connection?: boolean
confirm_plaintext_storage?: true
confirm_memory_only: true
} | {
type: "model.channel.remove"
channel_id: string
} | {
type: "model.channel.discover"
channel_id: string
operation_id: string
confirm_external_processing: true
} | {
type: "model.channel.model"
channel_id: string
configuration: HostModelRequestModelConfiguration
confirm_history_processing?: true
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
}
channel_id?: string
display_name?: string
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
export type InputEventRunnerId = string
export type InputEventRunnerConsumptionStage = ("received" | "routed" | "installed")

export interface InputEvent {
input_event_id: InputEventRunnerId
task_id: InputEventRunnerId
kind: ("request" | "query" | "explanation" | "correction" | "cancel_work" | "cancel_run" | "stop_task" | "withdraw_goal" | "operation_completed" | "approval_decided")
record_id: InputEventRunnerId
caused_by_event_id?: InputEventRunnerId
request_id?: InputEventRunnerId
work_id?: InputEventRunnerId
run_id?: InputEventRunnerId
operation_id?: InputEventRunnerId
stage: InputEventRunnerConsumptionStage
route?: ("direct" | "clarification" | "semantic")
result_ref?: InputEventRunnerProvenanceRef
update_id?: InputEventRunnerId
}
export interface InputEventRunnerProvenanceRef {
task_id: InputEventRunnerId
kind: ("record" | "resource" | "action")
id: InputEventRunnerId
}
export type ConsumptionStage = ("received" | "routed" | "installed")
export type OutcomeRequirementRunnerId = string

export interface OutcomeRequirement {
requirement_id: OutcomeRequirementRunnerId
kind: ("answer" | "artifact" | "content_check")
required: boolean
provenance_required: boolean
}
export type GoalRevisionRunnerId = string

export interface GoalRevision {
task_id: GoalRevisionRunnerId
request_id: GoalRevisionRunnerId
intent_revision: number
input_event_id: GoalRevisionRunnerId
state: ("active" | "withdrawn")
requirements: GoalRevisionRunnerOutcomeRequirement[]
previous_revision?: number
}
export interface GoalRevisionRunnerOutcomeRequirement {
requirement_id: GoalRevisionRunnerId
kind: ("answer" | "artifact" | "content_check")
required: boolean
provenance_required: boolean
}
export type WorkDependency = ({
kind: "goal"
task_id: WorkDependencyRunnerId
request_id: WorkDependencyRunnerId
intent_revision: number
} | {
kind: "work"
task_id: WorkDependencyRunnerId
work_id: WorkDependencyRunnerId
result_revision: number
} | {
kind: "artifact"
task_id: WorkDependencyRunnerId
artifact_id: WorkDependencyRunnerId
artifact_revision: number
} | {
kind: "resource"
task_id: WorkDependencyRunnerId
resource_id: WorkDependencyRunnerId
} | WorkDependencyRunnerChapterDependency)
export type WorkDependencyRunnerId = string

export interface WorkDependencyRunnerChapterDependency {
kind: "chapter"
task_id: WorkDependencyRunnerId
view_id: WorkDependencyRunnerId
revision: number
region_id?: WorkDependencyRunnerId
}
export type RunnerRun = ({
run_id: RunnerRunRunnerId
task_id: RunnerRunRunnerId
runtime_epoch: RunnerRunRunnerId
state: ("queued" | "running" | "waiting" | "closing" | "completed" | "failed" | "cancelled" | "interrupted")
commit_valid: boolean
budget_id: RunnerRunRunnerId
previous_run_id?: RunnerRunRunnerId
purpose: "production"
request_id: RunnerRunRunnerId
intent_revision: number
update_id?: RunnerRunRunnerId
} | {
run_id: RunnerRunRunnerId
task_id: RunnerRunRunnerId
runtime_epoch: RunnerRunRunnerId
state: ("queued" | "running" | "waiting" | "closing" | "completed" | "failed" | "cancelled" | "interrupted")
commit_valid: boolean
budget_id: RunnerRunRunnerId
previous_run_id?: RunnerRunRunnerId
purpose: "composition"
batch_id: RunnerRunRunnerId
composition_version: number
trigger_request_id: RunnerRunRunnerId
})
export type RunnerRunRunnerId = string
export type LogicalWork = ({
work_id: LogicalWorkRunnerId
task_id: LogicalWorkRunnerId
run_id: LogicalWorkRunnerId
plan_revision: number
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
required: boolean
requirement_ids: LogicalWorkRunnerId[]
dependencies: LogicalWorkRunnerWorkDependency[]
state: ("planned" | "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "invalidated" | "dependency_failed" | "dependency_cancelled")
current_attempt_id?: LogicalWorkRunnerId
root_cause?: LogicalWorkRunnerWorkCause
result_revision?: number
max_attempts: number
purpose: "production"
request_id: LogicalWorkRunnerId
intent_revision: number
update_id?: LogicalWorkRunnerId
} | {
work_id: LogicalWorkRunnerId
task_id: LogicalWorkRunnerId
run_id: LogicalWorkRunnerId
plan_revision: number
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
required: boolean
requirement_ids: LogicalWorkRunnerId[]
dependencies: LogicalWorkRunnerWorkDependency[]
state: ("planned" | "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "invalidated" | "dependency_failed" | "dependency_cancelled")
current_attempt_id?: LogicalWorkRunnerId
root_cause?: LogicalWorkRunnerWorkCause
result_revision?: number
max_attempts: number
purpose: "composition"
batch_id: LogicalWorkRunnerId
composition_version: number
trigger_request_id: LogicalWorkRunnerId
})
export type LogicalWorkRunnerId = string
export type LogicalWorkRunnerWorkDependency = ({
kind: "goal"
task_id: LogicalWorkRunnerId
request_id: LogicalWorkRunnerId
intent_revision: number
} | {
kind: "work"
task_id: LogicalWorkRunnerId
work_id: LogicalWorkRunnerId
result_revision: number
} | {
kind: "artifact"
task_id: LogicalWorkRunnerId
artifact_id: LogicalWorkRunnerId
artifact_revision: number
} | {
kind: "resource"
task_id: LogicalWorkRunnerId
resource_id: LogicalWorkRunnerId
} | LogicalWorkRunnerChapterDependency)

export interface LogicalWorkRunnerChapterDependency {
kind: "chapter"
task_id: LogicalWorkRunnerId
view_id: LogicalWorkRunnerId
revision: number
region_id?: LogicalWorkRunnerId
}
export interface LogicalWorkRunnerWorkCause {
kind: ("failure" | "cancellation" | "invalidation")
work_id: LogicalWorkRunnerId
attempt_id?: LogicalWorkRunnerId
operation_id?: LogicalWorkRunnerId
}
export type ExecutionAttempt = ({
attempt_id: ExecutionAttemptRunnerId
task_id: ExecutionAttemptRunnerId
run_id: ExecutionAttemptRunnerId
work_id: ExecutionAttemptRunnerId
runtime_epoch: ExecutionAttemptRunnerId
attempt_number: number
profile_id: ExecutionAttemptRunnerId
model_config_id: ExecutionAttemptRunnerId
model_config_revision: number
input_versions: ExecutionAttemptRunnerWorkDependency[]
state: ("registered" | "queued" | "dispatched" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown" | "revoked")
dispatch_state: ("not_dispatched" | "dispatched" | "unknown")
previous_attempt_id?: ExecutionAttemptRunnerId
operation_id?: ExecutionAttemptRunnerId
result_ref?: ExecutionAttemptRunnerProvenanceRef
usage_refs: ExecutionAttemptRunnerId[]
purpose: "production"
request_id: ExecutionAttemptRunnerId
intent_revision: number
update_id?: ExecutionAttemptRunnerId
} | {
attempt_id: ExecutionAttemptRunnerId
task_id: ExecutionAttemptRunnerId
run_id: ExecutionAttemptRunnerId
work_id: ExecutionAttemptRunnerId
runtime_epoch: ExecutionAttemptRunnerId
attempt_number: number
profile_id: ExecutionAttemptRunnerId
model_config_id: ExecutionAttemptRunnerId
model_config_revision: number
input_versions: ExecutionAttemptRunnerWorkDependency[]
state: ("registered" | "queued" | "dispatched" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown" | "revoked")
dispatch_state: ("not_dispatched" | "dispatched" | "unknown")
previous_attempt_id?: ExecutionAttemptRunnerId
operation_id?: ExecutionAttemptRunnerId
result_ref?: ExecutionAttemptRunnerProvenanceRef
usage_refs: ExecutionAttemptRunnerId[]
purpose: "composition"
batch_id: ExecutionAttemptRunnerId
composition_version: number
trigger_request_id: ExecutionAttemptRunnerId
})
export type ExecutionAttemptRunnerId = string
export type ExecutionAttemptRunnerWorkDependency = ({
kind: "goal"
task_id: ExecutionAttemptRunnerId
request_id: ExecutionAttemptRunnerId
intent_revision: number
} | {
kind: "work"
task_id: ExecutionAttemptRunnerId
work_id: ExecutionAttemptRunnerId
result_revision: number
} | {
kind: "artifact"
task_id: ExecutionAttemptRunnerId
artifact_id: ExecutionAttemptRunnerId
artifact_revision: number
} | {
kind: "resource"
task_id: ExecutionAttemptRunnerId
resource_id: ExecutionAttemptRunnerId
} | ExecutionAttemptRunnerChapterDependency)

export interface ExecutionAttemptRunnerChapterDependency {
kind: "chapter"
task_id: ExecutionAttemptRunnerId
view_id: ExecutionAttemptRunnerId
revision: number
region_id?: ExecutionAttemptRunnerId
}
export interface ExecutionAttemptRunnerProvenanceRef {
task_id: ExecutionAttemptRunnerId
kind: ("record" | "resource" | "action")
id: ExecutionAttemptRunnerId
}
export type ExecutionScope = ({
task_id: ExecutionScopeRunnerId
run_id: ExecutionScopeRunnerId
work_id: ExecutionScopeRunnerId
attempt_id: ExecutionScopeRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "production"
request_id: ExecutionScopeRunnerId
intent_revision: number
update_id?: ExecutionScopeRunnerId
} | {
task_id: ExecutionScopeRunnerId
run_id: ExecutionScopeRunnerId
work_id: ExecutionScopeRunnerId
attempt_id: ExecutionScopeRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "composition"
batch_id: ExecutionScopeRunnerId
composition_version: number
trigger_request_id: ExecutionScopeRunnerId
})
export type ExecutionScopeRunnerId = string
export type OutlineRunnerId = string

export interface Outline {
task_id: OutlineRunnerId
outline_revision: number
base_outline_revision: number
sections: OutlineRunnerOutlineSection[]
}
export interface OutlineRunnerOutlineSection {
section_id: OutlineRunnerId
request_id: OutlineRunnerId
intent_revision: number
order_key: OutlineRunnerId
position_revision: number
title?: string
}
export type OutlineSectionRunnerId = string

export interface OutlineSection {
section_id: OutlineSectionRunnerId
request_id: OutlineSectionRunnerId
intent_revision: number
order_key: OutlineSectionRunnerId
position_revision: number
title?: string
}
export type ArtifactIndexRunnerId = string
export type ArtifactIndexRunnerPresentationKind = "managed-v1"
export type ArtifactIndexRunnerWidthConstraint = ("full" | "flexible")
export type ArtifactIndexRunnerInteractionKind = ("none" | "input")

export interface ArtifactIndex {
task_id: ArtifactIndexRunnerId
request_id: ArtifactIndexRunnerId
run_id: ArtifactIndexRunnerId
work_id: ArtifactIndexRunnerId
attempt_id: ArtifactIndexRunnerId
intent_revision: number
artifact_id: ArtifactIndexRunnerId
artifact_revision: number
bundle_resource_id: ArtifactIndexRunnerId
section_id: ArtifactIndexRunnerId
order_key: ArtifactIndexRunnerId
presentation_kind: ArtifactIndexRunnerPresentationKind
width_constraint: ArtifactIndexRunnerWidthConstraint
interaction_kind: ArtifactIndexRunnerInteractionKind
provenance_ref: ArtifactIndexRunnerProvenanceRef
acceptance_state: "accepted"
title?: string
}
export interface ArtifactIndexRunnerProvenanceRef {
task_id: ArtifactIndexRunnerId
kind: ("record" | "resource" | "action")
id: ArtifactIndexRunnerId
}
export type ArtifactCandidateRunnerId = string
export type ArtifactCandidateRunnerPresentationKind = "managed-v1"
export type ArtifactCandidateRunnerWidthConstraint = ("full" | "flexible")
export type ArtifactCandidateRunnerInteractionKind = ("none" | "input")
export type ArtifactCandidateRunnerWorkDependency = ({
kind: "goal"
task_id: ArtifactCandidateRunnerId
request_id: ArtifactCandidateRunnerId
intent_revision: number
} | {
kind: "work"
task_id: ArtifactCandidateRunnerId
work_id: ArtifactCandidateRunnerId
result_revision: number
} | {
kind: "artifact"
task_id: ArtifactCandidateRunnerId
artifact_id: ArtifactCandidateRunnerId
artifact_revision: number
} | {
kind: "resource"
task_id: ArtifactCandidateRunnerId
resource_id: ArtifactCandidateRunnerId
} | ArtifactCandidateRunnerChapterDependency)

export interface ArtifactCandidate {
task_id: ArtifactCandidateRunnerId
request_id: ArtifactCandidateRunnerId
run_id: ArtifactCandidateRunnerId
work_id: ArtifactCandidateRunnerId
attempt_id: ArtifactCandidateRunnerId
intent_revision: number
artifact_id: ArtifactCandidateRunnerId
bundle_resource_id: ArtifactCandidateRunnerId
section_id: ArtifactCandidateRunnerId
order_key: ArtifactCandidateRunnerId
presentation_kind: ArtifactCandidateRunnerPresentationKind
width_constraint: ArtifactCandidateRunnerWidthConstraint
interaction_kind: ArtifactCandidateRunnerInteractionKind
provenance_ref: ArtifactCandidateRunnerProvenanceRef
title?: string
candidate_id: ArtifactCandidateRunnerId
base_artifact_revision: number
plan_revision: number
section_position_revision: number
dependencies: ArtifactCandidateRunnerWorkDependency[]
requirement_ids: ArtifactCandidateRunnerId[]
unresolved: ArtifactCandidateRunnerRequirementRef[]
}
export interface ArtifactCandidateRunnerProvenanceRef {
task_id: ArtifactCandidateRunnerId
kind: ("record" | "resource" | "action")
id: ArtifactCandidateRunnerId
}
export interface ArtifactCandidateRunnerChapterDependency {
kind: "chapter"
task_id: ArtifactCandidateRunnerId
view_id: ArtifactCandidateRunnerId
revision: number
region_id?: ArtifactCandidateRunnerId
}
export interface ArtifactCandidateRunnerRequirementRef {
task_id: ArtifactCandidateRunnerId
request_id: ArtifactCandidateRunnerId
intent_revision: number
requirement_id: ArtifactCandidateRunnerId
}
export type PresentationPlanRunnerId = string
export type PresentationPlanRunnerWidthConstraint = ("full" | "flexible")

export interface PresentationPlan {
task_id: PresentationPlanRunnerId
run_id: PresentationPlanRunnerId
batch_id: PresentationPlanRunnerId
composition_version: number
/**
 * @maxItems 16
 */
intents: []|[PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]|[PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent, PresentationPlanRunnerPresentationIntent]
}
export interface PresentationPlanRunnerPresentationIntent {
artifact: PresentationPlanRunnerArtifactRef
section_id: PresentationPlanRunnerId
section_position_revision: number
order_key: PresentationPlanRunnerId
slot_id: "main"
layout_mode: ("column" | "responsive_columns")
width_constraint: PresentationPlanRunnerWidthConstraint
}
export interface PresentationPlanRunnerArtifactRef {
task_id: PresentationPlanRunnerId
artifact_id: PresentationPlanRunnerId
artifact_revision: number
}
export type CompositionScopeRunnerId = string

export interface CompositionScope {
task_id: CompositionScopeRunnerId
composition_version: number
previous_version?: number
targets: CompositionScopeRunnerScopeTarget[]
state: ("working" | "complete")
unresolved: CompositionScopeRunnerRequirementRef[]
publication_manifest_id?: CompositionScopeRunnerId
}
export interface CompositionScopeRunnerScopeTarget {
request_id: CompositionScopeRunnerId
intent_revision: number
required: boolean
requirement_ids: CompositionScopeRunnerId[]
contribution_inventory?: CompositionScopeRunnerContributionInventoryRef
}
export interface CompositionScopeRunnerContributionInventoryRef {
task_id: CompositionScopeRunnerId
request_id: CompositionScopeRunnerId
intent_revision: number
inventory_revision: number
}
export interface CompositionScopeRunnerRequirementRef {
task_id: CompositionScopeRunnerId
request_id: CompositionScopeRunnerId
intent_revision: number
requirement_id: CompositionScopeRunnerId
}
export type CompositionBatchRunnerId = string

export interface CompositionBatch {
task_id: CompositionBatchRunnerId
batch_id: CompositionBatchRunnerId
composition_version: number
run_id: CompositionBatchRunnerId
trigger_request_id: CompositionBatchRunnerId
model_config_id: CompositionBatchRunnerId
model_config_revision: number
state: ("queued" | "preparing" | "prepared" | "waiting" | "publishing" | "published" | "failed" | "unknown" | "cancelled" | "invalidated")
targets: CompositionBatchRunnerGoalRef[]
/**
 * @maxItems 16
 */
indexes: []|[CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]|[CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef, CompositionBatchRunnerArtifactRef]
/**
 * @maxItems 16
 */
sections: []|[CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]|[CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint, CompositionBatchRunnerSectionConstraint]
previous_batch_id?: CompositionBatchRunnerId
operation_id?: CompositionBatchRunnerId
action_id?: CompositionBatchRunnerId
}
export interface CompositionBatchRunnerGoalRef {
task_id: CompositionBatchRunnerId
request_id: CompositionBatchRunnerId
intent_revision: number
}
export interface CompositionBatchRunnerArtifactRef {
task_id: CompositionBatchRunnerId
artifact_id: CompositionBatchRunnerId
artifact_revision: number
}
export interface CompositionBatchRunnerSectionConstraint {
section_id: CompositionBatchRunnerId
position_revision: number
order_key: CompositionBatchRunnerId
}
export type DeliveryRecord = ({
delivery_id: DeliveryRecordRunnerId
task_id: DeliveryRecordRunnerId
run_id: DeliveryRecordRunnerId
work_id: DeliveryRecordRunnerId
attempt_id: DeliveryRecordRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
record_id: DeliveryRecordRunnerId
input_event_id: DeliveryRecordRunnerId
request_id: DeliveryRecordRunnerId
intent_revision: number
purpose: "final_answer"
} | {
delivery_id: DeliveryRecordRunnerId
task_id: DeliveryRecordRunnerId
run_id: DeliveryRecordRunnerId
work_id: DeliveryRecordRunnerId
attempt_id: DeliveryRecordRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
record_id: DeliveryRecordRunnerId
input_event_id?: DeliveryRecordRunnerId
request_id?: DeliveryRecordRunnerId
intent_revision?: number
purpose: ("progress" | "diagnostic")
} | {
delivery_id: DeliveryRecordRunnerId
task_id: DeliveryRecordRunnerId
run_id: DeliveryRecordRunnerId
work_id: DeliveryRecordRunnerId
attempt_id: DeliveryRecordRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
record_id: DeliveryRecordRunnerId
input_event_id?: DeliveryRecordRunnerId
purpose: "composition"
batch_id: DeliveryRecordRunnerId
composition_version: number
publication_manifest_id?: DeliveryRecordRunnerId
})
export type DeliveryRecordRunnerId = string
export type DeliveryQueryRunnerId = string

export interface DeliveryQuery {
task_id: DeliveryQueryRunnerId
purpose: ("final_answer" | "progress" | "diagnostic" | "composition")
request_id?: DeliveryQueryRunnerId
input_event_id?: DeliveryQueryRunnerId
limit: number
after_delivery_id?: DeliveryQueryRunnerId
}
export type PublicationManifestRunnerId = string
export type PublicationManifestRunnerPublicationEntry = ({
task_id: PublicationManifestRunnerId
batch_id?: PublicationManifestRunnerId
chapter_update_id?: PublicationManifestRunnerId
chapter_operation_id?: PublicationManifestRunnerId
request_id: PublicationManifestRunnerId
intent_revision: number
artifact_id: PublicationManifestRunnerId
artifact_revision: number
section_id: PublicationManifestRunnerId
source_bundle_resource_id: PublicationManifestRunnerId
published_bundle_resource_id: PublicationManifestRunnerId
view_id: PublicationManifestRunnerId
view_revision: number
state_revision: number
surface_history_id: PublicationManifestRunnerId
} & PublicationManifestRunnerPublicationEntry1)
export type PublicationManifestRunnerPublicationEntry1 = ({ batch_id: string; chapter_update_id?: never; chapter_operation_id?: never } | { batch_id?: never; chapter_update_id: string; chapter_operation_id: string })

export interface PublicationManifest {
manifest_id: PublicationManifestRunnerId
task_id: PublicationManifestRunnerId
composition_version: number
operation_id: PublicationManifestRunnerId
action_id: PublicationManifestRunnerId
surface_id: PublicationManifestRunnerId
surface_revision: number
state: ("partial" | "complete")
targets: PublicationManifestRunnerGoalRef[]
contributions: PublicationManifestRunnerPublicationEntry[]
unresolved: PublicationManifestRunnerRequirementRef[]
}
export interface PublicationManifestRunnerGoalRef {
task_id: PublicationManifestRunnerId
request_id: PublicationManifestRunnerId
intent_revision: number
}
export interface PublicationManifestRunnerRequirementRef {
task_id: PublicationManifestRunnerId
request_id: PublicationManifestRunnerId
intent_revision: number
requirement_id: PublicationManifestRunnerId
}
export type PublicationEntry = ({
task_id: PublicationEntryRunnerId
batch_id?: PublicationEntryRunnerId
chapter_update_id?: PublicationEntryRunnerId
chapter_operation_id?: PublicationEntryRunnerId
request_id: PublicationEntryRunnerId
intent_revision: number
artifact_id: PublicationEntryRunnerId
artifact_revision: number
section_id: PublicationEntryRunnerId
source_bundle_resource_id: PublicationEntryRunnerId
published_bundle_resource_id: PublicationEntryRunnerId
view_id: PublicationEntryRunnerId
view_revision: number
state_revision: number
surface_history_id: PublicationEntryRunnerId
} & ({ batch_id: string; chapter_update_id?: never; chapter_operation_id?: never } | { batch_id?: never; chapter_update_id: string; chapter_operation_id: string }))
export type PublicationEntryRunnerId = string
export type WorkOutputDeclarationRunnerId = string

export interface WorkOutputDeclaration {
task_id: WorkOutputDeclarationRunnerId
request_id: WorkOutputDeclarationRunnerId
intent_revision: number
run_id: WorkOutputDeclarationRunnerId
work_id: WorkOutputDeclarationRunnerId
attempt_id: WorkOutputDeclarationRunnerId
plan_revision: number
result_revision: number
result_ref: WorkOutputDeclarationRunnerProvenanceRef
complete: true
artifacts: WorkOutputDeclarationRunnerArtifactRef[]
requirement_ids: WorkOutputDeclarationRunnerId[]
unresolved: WorkOutputDeclarationRunnerRequirementRef[]
}
export interface WorkOutputDeclarationRunnerProvenanceRef {
task_id: WorkOutputDeclarationRunnerId
kind: ("record" | "resource" | "action")
id: WorkOutputDeclarationRunnerId
}
export interface WorkOutputDeclarationRunnerArtifactRef {
task_id: WorkOutputDeclarationRunnerId
artifact_id: WorkOutputDeclarationRunnerId
artifact_revision: number
}
export interface WorkOutputDeclarationRunnerRequirementRef {
task_id: WorkOutputDeclarationRunnerId
request_id: WorkOutputDeclarationRunnerId
intent_revision: number
requirement_id: WorkOutputDeclarationRunnerId
}
export type ContributionInventoryRunnerId = string

export interface ContributionInventory {
task_id: ContributionInventoryRunnerId
request_id: ContributionInventoryRunnerId
intent_revision: number
inventory_revision: number
previous_revision?: number
sealed_by: ContributionInventoryRunnerContributionSource
required_works: ContributionInventoryRunnerWorkOutputDeclaration[]
requirement_ids: ContributionInventoryRunnerId[]
unresolved: ContributionInventoryRunnerRequirementRef[]
}
export interface ContributionInventoryRunnerContributionSource {
run_id: ContributionInventoryRunnerId
work_id: ContributionInventoryRunnerId
attempt_id: ContributionInventoryRunnerId
plan_revision: number
role: ("router" | "producer")
}
export interface ContributionInventoryRunnerWorkOutputDeclaration {
task_id: ContributionInventoryRunnerId
request_id: ContributionInventoryRunnerId
intent_revision: number
run_id: ContributionInventoryRunnerId
work_id: ContributionInventoryRunnerId
attempt_id: ContributionInventoryRunnerId
plan_revision: number
result_revision: number
result_ref: ContributionInventoryRunnerProvenanceRef
complete: true
artifacts: ContributionInventoryRunnerArtifactRef[]
requirement_ids: ContributionInventoryRunnerId[]
unresolved: ContributionInventoryRunnerRequirementRef[]
}
export interface ContributionInventoryRunnerProvenanceRef {
task_id: ContributionInventoryRunnerId
kind: ("record" | "resource" | "action")
id: ContributionInventoryRunnerId
}
export interface ContributionInventoryRunnerArtifactRef {
task_id: ContributionInventoryRunnerId
artifact_id: ContributionInventoryRunnerId
artifact_revision: number
}
export interface ContributionInventoryRunnerRequirementRef {
task_id: ContributionInventoryRunnerId
request_id: ContributionInventoryRunnerId
intent_revision: number
requirement_id: ContributionInventoryRunnerId
}
export type ContributionInventoryRefRunnerId = string

export interface ContributionInventoryRef {
task_id: ContributionInventoryRefRunnerId
request_id: ContributionInventoryRefRunnerId
intent_revision: number
inventory_revision: number
}
export type ChapterDependencyRunnerId = string

export interface ChapterDependency {
kind: "chapter"
task_id: ChapterDependencyRunnerId
view_id: ChapterDependencyRunnerId
revision: number
region_id?: ChapterDependencyRunnerId
}
export type ChapterOwnershipRunnerId = string

export interface ChapterOwnership {
/**
 * @maxItems 256
 */
form_ids: ChapterOwnershipRunnerId[]
/**
 * @maxItems 256
 */
behavior_ids: ChapterOwnershipRunnerId[]
/**
 * @maxItems 256
 */
reference_ids: ChapterOwnershipRunnerId[]
/**
 * @maxItems 256
 */
export_ids: ChapterOwnershipRunnerId[]
/**
 * @maxItems 256
 */
css_selectors: string[]
}
export type ChapterRegionRunnerId = string

export interface ChapterRegion {
region_id: ChapterRegionRunnerId
revision: number
title: string
title_selector: string
body_selector: string
/**
 * @maxItems 256
 */
dependencies: ChapterRegionRunnerChapterDependency[]
ownership: ChapterRegionRunnerChapterOwnership
}
export interface ChapterRegionRunnerChapterDependency {
kind: "chapter"
task_id: ChapterRegionRunnerId
view_id: ChapterRegionRunnerId
revision: number
region_id?: ChapterRegionRunnerId
}
export interface ChapterRegionRunnerChapterOwnership {
/**
 * @maxItems 256
 */
form_ids: ChapterRegionRunnerId[]
/**
 * @maxItems 256
 */
behavior_ids: ChapterRegionRunnerId[]
/**
 * @maxItems 256
 */
reference_ids: ChapterRegionRunnerId[]
/**
 * @maxItems 256
 */
export_ids: ChapterRegionRunnerId[]
/**
 * @maxItems 256
 */
css_selectors: string[]
}
export type ChapterManifestRunnerId = string
export type ChapterManifestRunnerContentTree = ContentTree

export interface ChapterManifest {
task_id: ChapterManifestRunnerId
view_id: ChapterManifestRunnerId
view_revision: number
state_revision: number
bundle_resource_id: ChapterManifestRunnerId
manifest_revision: number
shared_revision: number
request_id: ChapterManifestRunnerId
intent_revision: number
artifact_id?: ChapterManifestRunnerId
artifact_revision?: number
/**
 * @minItems 1
 * @maxItems 256
 */
chapters: ChapterRegion[]
content_tree?: ChapterManifestRunnerContentTree
}
export type ChapterIntentRunnerId = string

export interface ChapterIntent {
region_id: ChapterIntentRunnerId
intent_revision: number
}
export type ChapterUpdate = ({
[k: string]: unknown
} & {
task_id: ChapterUpdateRunnerId
update_id: ChapterUpdateRunnerId
input_event_id: ChapterUpdateRunnerId
record_id: ChapterUpdateRunnerId
request_id: ChapterUpdateRunnerId
intent_revision: number
view_id: ChapterUpdateRunnerId
base_manifest: ChapterUpdateRunnerChapterManifest
/**
 * @minItems 0
 * @maxItems 256
 */
region_ids: string[]
/**
 * @minItems 0
 * @maxItems 256
 */
region_intents: ChapterIntent[]
/**
 * @maxItems 256
 */
dependencies: ChapterUpdateRunnerChapterDependency[]
state: ("queued" | "generating" | "waiting_input" | "waiting_approval" | "assembling" | "publishing" | "unknown" | "succeeded" | "failed" | "cancelled" | "interrupted" | "superseded")
text: string
model_config_id?: ChapterUpdateRunnerId
source?: ChapterUpdateRunnerExecutionScope
proposal_id?: ChapterUpdateRunnerId
publication_operation_id?: ChapterUpdateRunnerId
action_id?: ChapterUpdateRunnerId
/**
 * @maxItems 256
 */
previous_update_ids: ChapterUpdateRunnerId[]
reason?: string
/**
 * @minItems 1
 * @maxItems 256
 */
tree_operations?: ContentOperationPlan[]
authorization?: ChapterUpdateRunnerContentAuthorization
/**
 * @maxItems 256
 */
candidate_region_ids?: string[]
/**
 * @minItems 1
 * @maxItems 256
 */
candidate_operations?: ContentOperationPlan[]
scope_revision?: number
request_order?: number
scope_active?: boolean
})
export type ChapterUpdateRunnerId = string
export type ChapterUpdateRunnerContentTree = ContentTree
export type ChapterUpdateRunnerExecutionScope = ({
task_id: ChapterUpdateRunnerId
run_id: ChapterUpdateRunnerId
work_id: ChapterUpdateRunnerId
attempt_id: ChapterUpdateRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "production"
request_id: ChapterUpdateRunnerId
intent_revision: number
update_id?: ChapterUpdateRunnerId
} | {
task_id: ChapterUpdateRunnerId
run_id: ChapterUpdateRunnerId
work_id: ChapterUpdateRunnerId
attempt_id: ChapterUpdateRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "composition"
batch_id: ChapterUpdateRunnerId
composition_version: number
trigger_request_id: ChapterUpdateRunnerId
})

export interface ChapterUpdateRunnerChapterManifest {
task_id: ChapterUpdateRunnerId
view_id: ChapterUpdateRunnerId
view_revision: number
state_revision: number
bundle_resource_id: ChapterUpdateRunnerId
manifest_revision: number
shared_revision: number
request_id: ChapterUpdateRunnerId
intent_revision: number
artifact_id?: ChapterUpdateRunnerId
artifact_revision?: number
/**
 * @minItems 1
 * @maxItems 256
 */
chapters: ChapterRegion[]
content_tree?: ChapterUpdateRunnerContentTree
}
export interface ChapterUpdateRunnerChapterDependency {
kind: "chapter"
task_id: ChapterUpdateRunnerId
view_id: ChapterUpdateRunnerId
revision: number
region_id?: ChapterUpdateRunnerId
}
export interface ChapterUpdateRunnerContentAuthorization {
record_id: ChapterUpdateRunnerId
input_event_id: ChapterUpdateRunnerId
/**
 * @minItems 1
 * @maxItems 256
 */
region_ids: string[]
}
export interface ChapterReplacement {
/**
 * @minItems 1
 * @maxItems 256
 */
previous_region_ids: string[]
/**
 * @minItems 1
 * @maxItems 256
 */
chapters: ChapterRegion[]
}
export type ChapterProposal = ({
[k: string]: unknown
} & {
task_id: ChapterProposalRunnerId
update_id: ChapterProposalRunnerId
proposal_id: ChapterProposalRunnerId
intent_revision: number
bundle_resource_id: ChapterProposalRunnerId
/**
 * @minItems 0
 * @maxItems 256
 */
replacements: ChapterReplacement[]
/**
 * @maxItems 256
 */
dependencies: ChapterProposalRunnerChapterDependency[]
source: ChapterProposalRunnerExecutionScope
/**
 * @minItems 1
 * @maxItems 256
 */
tree_operations?: ContentOperation[]
scope_revision?: number
/**
 * @maxItems 256
 */
read_refs?: string[]
})
export type ChapterProposalRunnerId = string
export type ChapterProposalRunnerExecutionScope = ({
task_id: ChapterProposalRunnerId
run_id: ChapterProposalRunnerId
work_id: ChapterProposalRunnerId
attempt_id: ChapterProposalRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "production"
request_id: ChapterProposalRunnerId
intent_revision: number
update_id?: ChapterProposalRunnerId
} | {
task_id: ChapterProposalRunnerId
run_id: ChapterProposalRunnerId
work_id: ChapterProposalRunnerId
attempt_id: ChapterProposalRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "composition"
batch_id: ChapterProposalRunnerId
composition_version: number
trigger_request_id: ChapterProposalRunnerId
})

export interface ChapterProposalRunnerChapterDependency {
kind: "chapter"
task_id: ChapterProposalRunnerId
view_id: ChapterProposalRunnerId
revision: number
region_id?: ChapterProposalRunnerId
}
export type ChapterInheritanceRunnerId = string

export interface ChapterInheritance {
task_id: ChapterInheritanceRunnerId
update_id: ChapterInheritanceRunnerId
view_id: ChapterInheritanceRunnerId
region_id: ChapterInheritanceRunnerId
region_revision: number
source_bundle_resource_id: ChapterInheritanceRunnerId
source_manifest_revision: number
request_id: ChapterInheritanceRunnerId
intent_revision: number
artifact_id?: ChapterInheritanceRunnerId
artifact_revision?: number
/**
 * @maxItems 256
 */
requirement_ids: ChapterInheritanceRunnerId[]
/**
 * @maxItems 256
 */
dependencies: ChapterInheritanceRunnerChapterDependency[]
valid: boolean
reason?: string
}
export interface ChapterInheritanceRunnerChapterDependency {
kind: "chapter"
task_id: ChapterInheritanceRunnerId
view_id: ChapterInheritanceRunnerId
revision: number
region_id?: ChapterInheritanceRunnerId
}
export type ChapterPublicationRunnerId = string
export type ChapterPublicationModelRequest = ({
type: "list"
input: ChapterPublicationList
} | {
type: "read"
input: ChapterPublicationModelRead
} | {
type: "write"
input: ChapterPublicationWrite
} | {
type: "call"
input: ChapterPublicationCall
})
export type ChapterPublicationModelRead = ({
[k: string]: unknown
} & {
target: ChapterPublicationModelTarget
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
export type ChapterPublicationWrite = ({
type: "surface.update"
surface_id: string
expected_revision: number
/**
 * @minItems 1
 * @maxItems 100
 */
operations: [ChapterPublicationViewOp, ...(ChapterPublicationViewOp)[]]
/**
 * @maxItems 32
 */
snapshot_sources?: ChapterPublicationTarget[]
} | {
type: "task_data.create"
data: ChapterPublicationDataValue
} | {
type: "task_data.replace"
id: string
expected_revision: number
/**
 * Actual JSON value, preserving its type. Objects and arrays must not be encoded as strings. The task object's fixed local schema further constrains the value.
 */
value: ({
[k: string]: ChapterPublicationJsonValue
} | ChapterPublicationJsonValue[] | string | number | boolean | null)
references: ChapterPublicationReferences
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
[k: string]: ChapterPublicationJsonValue
} | ChapterPublicationJsonValue[] | string | number | boolean | null)
})
})
export type ChapterPublicationViewOp = ({
type: "view.create"
client_ref: string
slot_id: string
bundle: ChapterPublicationBundleInput
} | {
type: "view.replace"
view_id: string
expected_view_revision: number
bundle: ChapterPublicationBundleInput
state_transition: ChapterPublicationStateTransition
} | {
type: "view.remove"
view_id: string
expected_view_revision: number
expected_state_revision: number
} | {
type: "layout.set"
layout: ChapterPublicationLayout
})
export type ChapterPublicationBundleInput = ({
type: "inline"
bundle: ChapterPublicationBundle
} | {
type: "resource"
resource: ChapterPublicationTarget
})
export type ChapterPublicationJsonPointer = string
export type ChapterPublicationBehavior = ({
type: "input"
element_id: string
field: ChapterPublicationJsonPointer
control: ("text" | "textarea" | "number" | "checkbox" | "radio" | "select" | "multiselect" | "range")
option_value?: unknown
} | {
type: "text"
element_id: string
field: ChapterPublicationJsonPointer
} | {
type: "visible"
element_id: string
field: ChapterPublicationJsonPointer
} | {
type: "toggle"
element_id: string
field: ChapterPublicationJsonPointer
} | {
type: "class_toggle"
element_id: string
field: ChapterPublicationJsonPointer
class_name: string
} | {
type: "submit"
element_id: string
form_id: string
})
/**
 * @maxItems 256
 */
export type ChapterPublicationReferences = ChapterPublicationReference[]
export type ChapterPublicationStateTransition = ({
type: "preserve"
expected_state_revision: number
compatibility_version: string
} | {
type: "reset"
expected_state_revision: number
initial: unknown
})
export type ChapterPublicationViewLocator = ({
type: "existing"
view_id: string
} | {
type: "created"
client_ref: string
})
/**
 * Actual JSON value, preserving its type. Objects and arrays must not be encoded as strings. The task object's fixed local schema further constrains the value.
 */
export type ChapterPublicationJsonValue = ({
[k: string]: ChapterPublicationJsonValue
} | ChapterPublicationJsonValue[] | string | number | boolean | null)

export interface ChapterPublication {
task_id: ChapterPublicationRunnerId
operation_id: ChapterPublicationRunnerId
update_id: ChapterPublicationRunnerId
proposal_id: ChapterPublicationRunnerId
base_manifest_revision: number
assembled_bundle_resource_id: ChapterPublicationRunnerId
view_id: ChapterPublicationRunnerId
expected_view_revision: number
expected_state_revision: number
request: ChapterPublicationModelRequest
/**
 * @minItems 1
 * @maxItems 256
 */
source_bundle_resource_ids: string[]
previous_operation_id?: ChapterPublicationRunnerId
action_id?: ChapterPublicationRunnerId
state: ("registered" | "prepared" | "dispatched" | "published" | "failure" | "cancelled" | "unknown" | "superseded")
scope_revision?: number
}
export interface ChapterPublicationList {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
filters?: {
name_query?: string
status?: string
since?: string
until?: string
}
limit?: number
cursor?: string
}
export interface ChapterPublicationModelTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "runner_outline" | "runner_batch" | "runner_artifact_index" | "runner_layout" | "content_tree" | "content_node")
id: string
expected_revision?: number
}
export interface ChapterPublicationBundle {
profile: "managed-v1"
html: string
css: string
state: ChapterPublicationState
forms: ChapterPublicationForm[]
behaviors: ChapterPublicationBehavior[]
references: ChapterPublicationReferences
export: ChapterPublicationExportFragment[]
}
export interface ChapterPublicationState {
schema: ChapterPublicationLocalSchema
initial: unknown
compatibility_version: string
}
export interface ChapterPublicationLocalSchema {
type: ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")
description?: string
properties?: {
[k: string]: ChapterPublicationLocalSchema
}
required?: string[]
additionalProperties?: false
items?: ChapterPublicationLocalSchema
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
export interface ChapterPublicationForm {
id: string
/**
 * @minItems 1
 */
fields: [ChapterPublicationJsonPointer, ...(ChapterPublicationJsonPointer)[]]
}
export interface ChapterPublicationReference {
name: string
target: ChapterPublicationTarget
}
export interface ChapterPublicationTarget {
kind: ("task" | "message" | "event" | "answer" | "surface" | "view" | "view_history" | "task_data" | "resource" | "object_type" | "plugin" | "capability" | "run" | "call" | "action" | "approval" | "summary" | "content_tree" | "content_node")
id: string
expected_revision?: number
}
export interface ChapterPublicationExportFragment {
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
evidence?: ChapterPublicationTarget[]
personal_binding?: {
version: 1
answer_id: string
view_history_id: string
}
}
export interface ChapterPublicationLayout {
slots: {
slot_id: string
groups: ChapterPublicationLayoutGroup[]
}[]
}
export interface ChapterPublicationLayoutGroup {
id: string
mode: ("column" | "responsive_columns")
views: ChapterPublicationViewLocator[]
/**
 * @minItems 1
 * @maxItems 6
 */
column_weights?: [number]|[number, number]|[number, number, number]|[number, number, number, number]|[number, number, number, number, number]|[number, number, number, number, number, number]
gap: ("none" | "small" | "medium" | "large")
align: ("start" | "center" | "stretch")
}
export interface ChapterPublicationDataValue {
schema: ChapterPublicationLocalSchema
/**
 * Actual JSON value matching schema. For an object schema pass an object such as {"stage":"initial"}, NOT a JSON-encoded string. Do not JSON.stringify this field. String values are valid only when the schema allows strings.
 */
value: ({
[k: string]: ChapterPublicationJsonValue
} | ChapterPublicationJsonValue[] | string | number | boolean | null)
references: ChapterPublicationReferences
}
export interface ChapterPublicationCall {
capability: string
arguments: ChapterPublicationJsonValue
references: ChapterPublicationReferences
}
export type ContentNodeRunnerId = string

export interface ContentNode {
node_id: ContentNodeRunnerId
parent_id: (ContentNodeRunnerId | null)
kind: ("document" | "section" | "paragraph" | "list" | "list_item" | "table" | "row" | "cell" | "code" | "formula" | "image" | "block")
revision: number
position_revision: number
title: string
/**
 * @minItems 0
 * @maxItems 10000
 */
children: string[]
selector: string
end_selector: string
tag: string
span: {
start: number
end: number
}
inner_span: {
start: number
end: number
}
}
export type ContentLineageRunnerId = string

export interface ContentLineage {
previous_node_id: ContentLineageRunnerId
/**
 * @minItems 0
 * @maxItems 10000
 */
successor_node_ids: string[]
revision: number
reason: ("split" | "merge" | "deleted" | "replaced")
}
export type ContentAuthorizationRunnerId = string

export interface ContentAuthorization {
record_id: ContentAuthorizationRunnerId
input_event_id: ContentAuthorizationRunnerId
/**
 * @minItems 1
 * @maxItems 256
 */
region_ids: string[]
}
export type ContentScopeRevisionRunnerId = string
export type ContentScopeRevisionRunnerExecutionScope = ({
task_id: ContentScopeRevisionRunnerId
run_id: ContentScopeRevisionRunnerId
work_id: ContentScopeRevisionRunnerId
attempt_id: ContentScopeRevisionRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "production"
request_id: ContentScopeRevisionRunnerId
intent_revision: number
update_id?: ContentScopeRevisionRunnerId
} | {
task_id: ContentScopeRevisionRunnerId
run_id: ContentScopeRevisionRunnerId
work_id: ContentScopeRevisionRunnerId
attempt_id: ContentScopeRevisionRunnerId
role: ("router" | "producer" | "lightweight" | "integrator" | "collator" | "diagnostic")
purpose: "composition"
batch_id: ContentScopeRevisionRunnerId
composition_version: number
trigger_request_id: ContentScopeRevisionRunnerId
})
export type ContentScopeRevisionRunnerContentTree = ContentTree

export interface ContentScopeRevision {
task_id: ContentScopeRevisionRunnerId
update_id: ContentScopeRevisionRunnerId
revision: number
request_order: number
source: ContentScopeRevisionRunnerExecutionScope
base_manifest: ContentScopeRevisionRunnerChapterManifest
/**
 * @minItems 1
 * @maxItems 256
 */
operations: ContentOperationPlan[]
/**
 * @maxItems 256
 */
read_refs: string[]
/**
 * @maxItems 256
 */
dependencies: ContentScopeRevisionRunnerChapterDependency[]
}
export interface ContentScopeRevisionRunnerChapterManifest {
task_id: ContentScopeRevisionRunnerId
view_id: ContentScopeRevisionRunnerId
view_revision: number
state_revision: number
bundle_resource_id: ContentScopeRevisionRunnerId
manifest_revision: number
shared_revision: number
request_id: ContentScopeRevisionRunnerId
intent_revision: number
artifact_id?: ContentScopeRevisionRunnerId
artifact_revision?: number
/**
 * @minItems 1
 * @maxItems 256
 */
chapters: ChapterRegion[]
content_tree?: ContentScopeRevisionRunnerContentTree
}
export interface ContentScopeRevisionRunnerChapterDependency {
kind: "chapter"
task_id: ContentScopeRevisionRunnerId
view_id: ContentScopeRevisionRunnerId
revision: number
region_id?: ContentScopeRevisionRunnerId
}
export type ContentTreeRunnerId = string

export interface ContentTree {
version: 1
revision: number
root_id: ContentTreeRunnerId
/**
 * @minItems 1
 * @maxItems 10000
 */
nodes: ContentNode[]
/**
 * @maxItems 10000
 */
lineage: ContentLineage[]
}
export type ContentOperation = ({
type: "replace"
/**
 * @minItems 1
 * @maxItems 256
 */
node_ids: string[]
html: string
} | {
type: "insert"
parent_id: ContentOperationRunnerId
position: ("before" | "after")
anchor_id: ContentOperationRunnerId
html: string
} | {
type: "insert"
parent_id: ContentOperationRunnerId
position: ("start" | "end")
html: string
} | {
type: "delete"
/**
 * @minItems 1
 * @maxItems 256
 */
node_ids: string[]
} | {
type: "move"
/**
 * @minItems 1
 * @maxItems 1
 */
node_ids: string[]
parent_id: ContentOperationRunnerId
position: ("before" | "after")
anchor_id: ContentOperationRunnerId
} | {
type: "move"
/**
 * @minItems 1
 * @maxItems 1
 */
node_ids: string[]
parent_id: ContentOperationRunnerId
position: ("start" | "end")
})
export type ContentOperationRunnerId = string
export type ContentOperationPlan = ({
type: "replace"
/**
 * @minItems 1
 * @maxItems 256
 */
node_ids: string[]
html?: string
} | {
type: "insert"
parent_id: ContentOperationPlanRunnerId
position: ("before" | "after")
anchor_id: ContentOperationPlanRunnerId
html?: string
} | {
type: "insert"
parent_id: ContentOperationPlanRunnerId
position: ("start" | "end")
html?: string
} | {
type: "delete"
/**
 * @minItems 1
 * @maxItems 256
 */
node_ids: string[]
} | {
type: "move"
/**
 * @minItems 1
 * @maxItems 1
 */
node_ids: string[]
parent_id: ContentOperationPlanRunnerId
position: ("before" | "after")
anchor_id: ContentOperationPlanRunnerId
} | {
type: "move"
/**
 * @minItems 1
 * @maxItems 1
 */
node_ids: string[]
parent_id: ContentOperationPlanRunnerId
position: ("start" | "end")
})
export type ContentOperationPlanRunnerId = string
