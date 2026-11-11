#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

// This executable has no Node ABI, ambient search path or general execution
// interface. Its owner holds the only persistent Job handle.
struct Failure { const char* stage; DWORD status; };
[[noreturn]] static void fail(const char* stage, DWORD status = ERROR_INVALID_DATA) { throw Failure{stage, status}; }
static void check(BOOL ok, const char* stage) { if (!ok) fail(stage, GetLastError()); }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
struct Local {
  void* value = nullptr;
  ~Local() { if (value) LocalFree(value); }
};
static uint64_t decimal(const wchar_t* text, bool positive = false) {
  std::wstring s(text);
  if (s.empty() || s.size() > 20 || (s.size() > 1 && s[0] == L'0')) fail("identity");
  uint64_t n = 0;
  for (wchar_t c : s) {
    if (c < L'0' || c > L'9' || n > (UINT64_MAX - (c - L'0')) / 10) fail("identity");
    n = n * 10 + (c - L'0');
  }
  if (positive && !n) fail("identity");
  return n;
}
static void attach(const wchar_t* text) {
  const std::wstring prefix = L"Local\\Pliuna-";
  std::wstring name(text);
  if (name.size() != prefix.size() + 36 || name.compare(0, prefix.size(), prefix) != 0) fail("job-name");
  for (size_t i = prefix.size(); i < name.size(); i++) {
    wchar_t c = name[i];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || c == L'-')) fail("job-name");
  }
  Handle job(OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, FALSE, name.c_str()));
  check(job.value != nullptr, "job-open");
  check(AssignProcessToJobObject(job.value, GetCurrentProcess()), "job-attach");
  // Closing this temporary handle is essential for owner-crash cleanup.
}
struct State { BY_HANDLE_FILE_INFORMATION file; FILE_BASIC_INFO basic; };
static State state(HANDLE handle, uint64_t dev, uint64_t ino, bool directory) {
  State result = {};
  check(GetFileInformationByHandle(handle, &result.file), "file-info");
  check(GetFileInformationByHandleEx(handle, FileBasicInfo, &result.basic, sizeof(result.basic)), "file-basic");
  const auto& info = result.file;
  uint64_t id = (uint64_t(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
  if (GetFileType(handle) != FILE_TYPE_DISK || info.dwVolumeSerialNumber != dev || id != ino ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
      (!directory && info.nNumberOfLinks != 1)) fail("file-identity");
  return result;
}
static HANDLE open(const wchar_t* path, DWORD rights) {
  HANDLE h = CreateFileW(path, FILE_READ_ATTRIBUTES | rights,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (h == INVALID_HANDLE_VALUE) fail("file-open", GetLastError());
  return h;
}
struct Security {
  Local memory;
  PSID owner = nullptr, group = nullptr;
  PACL dacl = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  explicit Security(HANDLE h) {
    DWORD result = GetSecurityInfo(h, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, &group, &dacl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&memory.value));
    if (result != ERROR_SUCCESS) fail("security-read", result);
    DWORD revision = 0;
    check(GetSecurityDescriptorControl(memory.value, &control, &revision), "security-control");
    if (!owner || !group || !IsValidSid(owner) || !IsValidSid(group)) fail("security-owner");
    if (dacl && !IsValidAcl(dacl)) fail("security-acl");
  }
};
struct Principal {
  std::vector<unsigned char> token;
  unsigned char system[SECURITY_MAX_SID_SIZE] = {};
  PSID user;
  Principal() {
    HANDLE h = nullptr;
    if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &h)) {
      if (GetLastError() != ERROR_NO_TOKEN) fail("thread-token", GetLastError());
      check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &h), "process-token");
    }
    Handle handle(h);
    DWORD size = 0;
    GetTokenInformation(h, TokenUser, nullptr, 0, &size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !size) fail("token-size");
    token.resize(size);
    check(GetTokenInformation(h, TokenUser, token.data(), size, &size), "token-user");
    user = reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid;
    DWORD systemSize = sizeof(system);
    check(CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &systemSize), "system-sid");
  }
};
// Known legal ACL forms outside this deliberately narrow implementation select
// the original backend *before* any write. Corrupt/unknown forms fail closed.
static bool supported(PACL acl) {
  if (!acl) return true; // A null DACL is known non-private and must be tightened.
  for (DWORD i = 0; i < acl->AceCount; i++) {
    void* value = nullptr;
    check(GetAce(acl, i, &value), "ace-read");
    auto header = static_cast<ACE_HEADER*>(value);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE) {
      const size_t offset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
      if (header->AceSize < offset + 8) fail("ace-size");
      auto sid = reinterpret_cast<PSID>(static_cast<unsigned char*>(value) + offset);
      const auto raw = static_cast<SID*>(sid);
      if (header->AceSize < offset + 8 + DWORD(raw->SubAuthorityCount) * sizeof(DWORD) || !IsValidSid(sid)) fail("ace-sid");
      if (header->AceFlags & ~(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | NO_PROPAGATE_INHERIT_ACE | INHERIT_ONLY_ACE | INHERITED_ACE)) fail("ace-flags");
    } else if (header->AceType == ACCESS_ALLOWED_OBJECT_ACE_TYPE || header->AceType == ACCESS_DENIED_OBJECT_ACE_TYPE ||
               header->AceType == ACCESS_ALLOWED_CALLBACK_ACE_TYPE || header->AceType == ACCESS_DENIED_CALLBACK_ACE_TYPE ||
               header->AceType == ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE || header->AceType == ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE) return false;
    else fail("ace-type");
  }
  return true;
}
static bool equivalent(const Security& security, const Principal& principal, bool directory) {
  if (!(security.control & SE_DACL_PROTECTED) || !security.dacl) return false;
  bool same = EqualSid(principal.user, const_cast<unsigned char*>(principal.system)) != FALSE;
  if (security.dacl->AceCount != (same ? 1 : 2)) return false;
  bool user = false, system = false;
  for (DWORD i = 0; i < security.dacl->AceCount; i++) {
    void* value = nullptr;
    check(GetAce(security.dacl, i, &value), "ace-read");
    auto ace = static_cast<ACCESS_ALLOWED_ACE*>(value);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Mask != FILE_ALL_ACCESS ||
        ace->Header.AceFlags != (directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0)) return false;
    PSID sid = &ace->SidStart;
    if (EqualSid(sid, principal.user) && !user) user = true;
    else if (!same && EqualSid(sid, const_cast<unsigned char*>(principal.system)) && !system) system = true;
    else return false;
  }
  return user && (same || system);
}
static std::vector<unsigned char> desired(const Principal& principal, bool directory) {
  DWORD size = sizeof(ACL) + 2 * sizeof(ACCESS_ALLOWED_ACE) + GetLengthSid(principal.user) + GetLengthSid(const_cast<unsigned char*>(principal.system));
  std::vector<unsigned char> buffer(size);
  auto acl = reinterpret_cast<PACL>(buffer.data());
  check(InitializeAcl(acl, size, ACL_REVISION), "acl-create");
  DWORD flags = directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
  check(AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_ALL_ACCESS, principal.user), "acl-user");
  if (!EqualSid(principal.user, const_cast<unsigned char*>(principal.system)))
    check(AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_ALL_ACCESS, const_cast<unsigned char*>(principal.system)), "acl-system");
  return buffer;
}
static void injected(const wchar_t*) {}
static int run(int argc, wchar_t** argv) {
  if (argc != 8) fail("arguments");
  std::wstring operation(argv[1]), path(argv[3]), kind(argv[6]), hiddenText(argv[7]);
  if (operation != L"protect") {
    fail("operation");
  }
  if (path.size() > 32760 || path.find(L'\0') != std::wstring::npos ||
      path.substr(0, 4) != L"\\\\?\\" || (kind != L"file" && kind != L"directory") ||
      (hiddenText != L"0" && hiddenText != L"1")) fail("arguments");
  uint64_t dev = decimal(argv[4]), ino = decimal(argv[5], true);
  const bool directory = kind == L"directory", hidden = hiddenText == L"1" && directory;
  attach(argv[2]); // No file access or permission work before successful assignment.
  injected(L"fail-query");
  Handle read(open(path.c_str(), READ_CONTROL));
  State before = state(read.value, dev, ino, directory);
  wchar_t filesystem[64] = {};
  check(GetVolumeInformationByHandleW(read.value, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 64), "volume");
  Security initial(read.value);
  if (_wcsicmp(filesystem, L"NTFS") != 0 || !supported(initial.dacl)) {
    std::puts("{\"version\":1,\"backend\":\"legacy\",\"verified\":false,\"changed\":false}");
    return 0;
  }
  Principal principal;
  bool changeAcl = !equivalent(initial, principal, directory);
  bool changeHidden = hidden && !(before.file.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN);
  if (changeAcl || changeHidden) {
    // Request write privileges only after finding a known difference. Do not
    // use MAXIMUM_ALLOWED, which changes inheritance propagation semantics.
    Handle write(open(path.c_str(), READ_CONTROL | (changeAcl ? WRITE_DAC : 0) | (changeHidden ? FILE_WRITE_ATTRIBUTES : 0)));
    State current = state(write.value, dev, ino, directory);
    if (current.basic.ChangeTime.QuadPart != before.basic.ChangeTime.QuadPart ||
        current.basic.LastWriteTime.QuadPart != before.basic.LastWriteTime.QuadPart ||
        current.file.dwFileAttributes != before.file.dwFileAttributes) fail("file-changed");
    if (changeAcl) {
      auto buffer = desired(principal, directory);
      injected(L"fail-write");
      DWORD result = SetSecurityInfo(write.value, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, reinterpret_cast<PACL>(buffer.data()), nullptr);
      if (result != ERROR_SUCCESS) fail("security-write", result);
    }
    if (changeHidden) {
      FILE_BASIC_INFO attributes = {}; // Zero timestamps mean leave unchanged.
      attributes.FileAttributes = (before.file.dwFileAttributes & ~FILE_ATTRIBUTE_NORMAL) | FILE_ATTRIBUTE_HIDDEN;
      check(SetFileInformationByHandle(write.value, FileBasicInfo, &attributes, sizeof(attributes)), "attributes-write");
    }
  }
  injected(L"fail-verify");
  State after = state(read.value, dev, ino, directory);
  Security actual(read.value);
  if (!EqualSid(initial.owner, actual.owner) || !EqualSid(initial.group, actual.group)) fail("owner-changed");
  bool inspecting = false;
  if (!inspecting && (!equivalent(actual, principal, directory) || (hidden && !(after.file.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN)))) fail("security-verify");
  // A path replaced during the operation never becomes a successful result.
  Handle current(open(path.c_str(), 0));
  state(current.value, dev, ino, directory);
  std::printf("{\"version\":1,\"backend\":\"native\",\"verified\":%s,\"changed\":%s",
    inspecting ? "false" : "true", (changeAcl || changeHidden) ? "true" : "false");
  std::puts("}");
  return 0;
}
int wmain(int argc, wchar_t** argv) {
  try { return run(argc, argv); }
  catch (const Failure& e) { std::fprintf(stderr, "FILE_PERMISSIONS_UNAVAILABLE:%s:%lu\n", e.stage, e.status); }
  catch (...) { std::fputs("FILE_PERMISSIONS_UNAVAILABLE:unknown\n", stderr); }
  return 1;
}
