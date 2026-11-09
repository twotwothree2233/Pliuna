#include <windows.h>
#include <shlobj.h>
#include <cstdio>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <string>
#include <vector>
#include <stdexcept>

// Test-only executable. Never included in an application payload.
struct Error { const char* stage; DWORD status; };
static bool renamed = false;
static size_t actualNameLength = 0, expectedNameLength = 0;
[[noreturn]] static void fail(const char* stage, DWORD status = ERROR_INVALID_DATA) { throw Error{stage, status}; }
static void check(BOOL ok, const char* stage) { if (!ok) fail(stage, GetLastError()); }
struct Handle {
  HANDLE h;
  explicit Handle(const std::wstring& file, DWORD rights = 0, bool shareDelete = false) {
    h = CreateFileW(file.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL | rights,
      FILE_SHARE_READ | FILE_SHARE_WRITE | (shareDelete ? FILE_SHARE_DELETE : 0), nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (h == INVALID_HANDLE_VALUE) fail("open", GetLastError());
  }
  ~Handle() { CloseHandle(h); }
};
struct Identity { uint64_t dev, ino; };
static Identity identity(HANDLE h) {
  BY_HANDLE_FILE_INFORMATION info = {};
  check(GetFileInformationByHandle(h, &info), "identity");
  if (GetFileType(h) != FILE_TYPE_DISK || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) fail("directory-type");
  return { info.dwVolumeSerialNumber, (uint64_t(info.nFileIndexHigh) << 32) | info.nFileIndexLow };
}
static bool same(Identity a, Identity b) { return a.dev == b.dev && a.ino == b.ino; }
static uint64_t decimal(const wchar_t* s) {
  std::wstring text(s); uint64_t n = 0;
  if (text.empty() || text.size() > 20 || (text.size() > 1 && text[0] == L'0')) fail("argument");
  for (auto c : text) {
    if (c < L'0' || c > L'9' || n > (UINT64_MAX - (c - L'0')) / 10) fail("argument");
    n = n * 10 + c - L'0';
  }
  return n;
}
static std::vector<unsigned char> security(HANDLE h) {
  DWORD length = 0;
  const DWORD flags = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  GetKernelObjectSecurity(h, flags, nullptr, 0, &length);
  if (!length || GetLastError() != ERROR_INSUFFICIENT_BUFFER) fail("security-size");
  std::vector<unsigned char> result(length);
  check(GetKernelObjectSecurity(h, flags, result.data(), length, &length), "security");
  result.resize(length); return result;
}
static void absent(const std::wstring& file) {
  if (GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES) fail("destination-exists", ERROR_ALREADY_EXISTS);
  auto status = GetLastError();
  if (status != ERROR_FILE_NOT_FOUND) fail("destination-unknown", status);
}
static std::wstring finalPath(HANDLE h) {
  DWORD size = GetFinalPathNameByHandleW(h, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!size || size > 32768) fail("final-name-size", GetLastError());
  std::vector<wchar_t> buffer(size + 1);
  DWORD count = GetFinalPathNameByHandleW(h, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!count || count >= buffer.size()) fail("final-name", GetLastError());
  return std::wstring(buffer.data(), count);
}
static void move(const std::wstring& parent, const std::wstring& source, const std::wstring& destination,
                 Identity expectedParent, Identity expectedSource) {
  Handle p(parent), s(source, DELETE);
  if (!same(identity(p.h), expectedParent) || !same(identity(s.h), expectedSource)) fail("identity-mismatch");
  auto descriptor = security(s.h);
  absent(destination);
  const size_t bytes = destination.size() * sizeof(wchar_t);
  // The Win32 wrapper may normalize FileName before passing its explicit
  // byte length to NT. Keep a terminating WCHAR as well as FileNameLength.
  std::vector<unsigned char> buffer(sizeof(FILE_RENAME_INFO) + bytes + sizeof(wchar_t));
  auto rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  rename->ReplaceIfExists = FALSE; rename->RootDirectory = nullptr;
  rename->FileNameLength = static_cast<DWORD>(bytes);
  memcpy(rename->FileName, destination.data(), bytes);
  // Rename the held source object. No path reopen, copy fallback or overwrite.
  check(SetFileInformationByHandle(s.h, FileRenameInfo, rename, static_cast<DWORD>(buffer.size())), "rename");
  renamed = true;
  const auto actual = finalPath(s.h), expected = finalPath(p.h) + destination.substr(parent.size());
  actualNameLength = actual.size(); expectedNameLength = expected.size();
  if (_wcsicmp(actual.c_str(), expected.c_str()) != 0) fail("rename-name", ERROR_INVALID_NAME);
  Handle after(destination, 0, true);
  if (!same(identity(after.h), expectedSource) || !same(identity(p.h), expectedParent) || security(after.h) != descriptor) fail("postcondition");
  absent(source);
}
static Identity inspect(const std::wstring& file) { Handle h(file); return identity(h.h); }
static void probe(const std::wstring& root) {
  // The caller supplies a newly-created temp fixture. Existing names refuse.
  auto a = root + L"\\source", b = root + L"\\destination";
  check(CreateDirectoryW(a.c_str(), nullptr), "probe-create");
  check(CreateDirectoryW(b.c_str(), nullptr), "probe-create");
  auto p = inspect(root), s = inspect(a);
  bool rejected = false;
  try { move(root, a, b, p, s); } catch (Error e) { rejected = std::string(e.stage) == "destination-exists" && !renamed; }
  if (!rejected || !same(inspect(a), s)) fail("probe-no-overwrite");
  rejected = false;
  try { move(root, a, root + L"\\mismatch", p, {s.dev, s.ino ^ 1}); } catch (Error e) { rejected = std::string(e.stage) == "identity-mismatch" && !renamed; }
  if (!rejected || !same(inspect(a), s)) fail("probe-identity");
  move(root, a, root + L"\\preserved", p, s);
  if (!renamed || !same(inspect(root + L"\\preserved"), s)) fail("probe-move");
  std::puts("{\"version\":1,\"probe\":true,\"no_overwrite\":true,\"identity_refusal\":true,\"same_identity\":true,\"security_preserved\":true}");
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 3 && std::wstring(argv[1]) == L"probe") { probe(argv[2]); return 0; }
    if (argc != 7 || std::wstring(argv[1]) != L"preserve") fail("argument");
    PWSTR value = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &value))) fail("profile");
    std::wstring home(value); CoTaskMemFree(value);
    std::wstring leaf(argv[2]), prefix = L".trellis.ao-preserved-";
    if (leaf.substr(0, prefix.size()) != prefix || leaf.size() > 100 || leaf.size() == prefix.size()) fail("leaf");
    for (auto c : leaf.substr(prefix.size())) if ((c < L'0' || c > L'9') && c != L'-') fail("leaf");
    move(home, home + L"\\.trellis", home + L"\\" + leaf,
      {decimal(argv[3]), decimal(argv[4])}, {decimal(argv[5]), decimal(argv[6])});
    std::puts("{\"version\":1,\"renamed\":true,\"same_identity\":true,\"security_preserved\":true,\"source_absent\":true}");
    return 0;
  } catch (Error e) {
    std::printf("{\"version\":1,\"renamed\":%s,\"error\":\"%s\",\"status\":%lu,\"actual_name_length\":%zu,\"expected_name_length\":%zu}\n", renamed ? "true" : "false", e.stage, e.status, actualNameLength, expectedNameLength);
    return 1;
  } catch (...) { std::puts("{\"error\":\"unknown\"}"); return 1; }
}
