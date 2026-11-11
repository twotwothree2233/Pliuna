#include <node_api.h>
#include <windows.h>
#include <string>

// The owner keeps the only persistent handle. Never inherit or duplicate it:
// owner death must close the last handle in the kernel.
struct Job { HANDLE handle; };
static napi_value fail(napi_env env, const char* code) {
  napi_throw_error(env, code, code); return nullptr;
}
static napi_value undefined(napi_env env) {
  napi_value value; napi_get_undefined(env, &value); return value;
}
static void finalize(napi_env, void* data, void*) {
  auto job = static_cast<Job*>(data);
  if (job->handle) CloseHandle(job->handle);
  delete job;
}
static Job* argument(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_external(env, args[0], &data) != napi_ok || !data) {
    fail(env, "PROCESS_JOB_INVALID"); return nullptr;
  }
  auto job = static_cast<Job*>(data);
  if (!job->handle) { fail(env, "PROCESS_JOB_CLOSED"); return nullptr; }
  return job;
}
static std::wstring nameArgument(napi_env env, napi_callback_info info) {
  const std::wstring prefix = L"Local\\Pliuna-";
  size_t count = 1, length = 0; napi_value args[1];
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_string_utf16(env, args[0], nullptr, 0, &length) != napi_ok || length != prefix.size() + 36) {
    fail(env, "PROCESS_JOB_NAME_INVALID"); return L"";
  }
  std::u16string buffer(length + 1, u'\0');
  napi_get_value_string_utf16(env, args[0], &buffer[0], length + 1, &length);
  std::wstring name(buffer.begin(), buffer.begin() + length);
  if (name.compare(0, prefix.size(), prefix) != 0) { fail(env, "PROCESS_JOB_NAME_INVALID"); return L""; }
  for (size_t i = prefix.size(); i < name.size(); i++) {
    wchar_t c = name[i];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || c == L'-')) {
      fail(env, "PROCESS_JOB_NAME_INVALID"); return L"";
    }
  }
  return name;
}
static napi_value create(napi_env env, napi_callback_info info) {
  auto name = nameArgument(env, info); if (name.empty()) return nullptr;
  HANDLE handle = CreateJobObjectW(nullptr, name.c_str());
  DWORD status = GetLastError();
  if (!handle) return fail(env, "PROCESS_JOB_CREATE_FAILED");
  if (status == ERROR_ALREADY_EXISTS) { CloseHandle(handle); return fail(env, "PROCESS_JOB_NAME_COLLISION"); }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(handle); return fail(env, "PROCESS_JOB_CONFIGURE_FAILED");
  }
  auto job = new Job{handle}; napi_value value;
  if (napi_create_external(env, job, finalize, nullptr, &value) != napi_ok) {
    finalize(env, job, nullptr); return fail(env, "PROCESS_JOB_CREATE_FAILED");
  }
  return value;
}
static napi_value attach(napi_env env, napi_callback_info info) {
  auto name = nameArgument(env, info); if (name.empty()) return nullptr;
  HANDLE handle = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, FALSE, name.c_str());
  if (!handle) return fail(env, "PROCESS_JOB_ATTACH_FAILED");
  BOOL assigned = AssignProcessToJobObject(handle, GetCurrentProcess());
  CloseHandle(handle);
  if (!assigned) return fail(env, "PROCESS_JOB_ATTACH_FAILED");
  return undefined(env);
}
static napi_value active(napi_env env, napi_callback_info info) {
  auto job = argument(env, info); if (!job) return nullptr;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
  if (!QueryInformationJobObject(job->handle, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr))
    return fail(env, "PROCESS_JOB_QUERY_FAILED");
  napi_value value; napi_create_uint32(env, accounting.ActiveProcesses, &value); return value;
}
static napi_value terminate(napi_env env, napi_callback_info info) {
  auto job = argument(env, info); if (!job) return nullptr;
  if (!TerminateJobObject(job->handle, 1)) return fail(env, "PROCESS_JOB_TERMINATION_FAILED");
  return undefined(env);
}
static napi_value close(napi_env env, napi_callback_info info) {
  auto job = argument(env, info); if (!job) return nullptr;
  if (!CloseHandle(job->handle)) return fail(env, "PROCESS_JOB_CLOSE_FAILED");
  job->handle = nullptr; return undefined(env);
}
NAPI_MODULE_INIT() {
  const napi_property_descriptor properties[] = {
    {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"attach", nullptr, attach, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"active", nullptr, active, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminate", nullptr, terminate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
