{
  "target_defaults": {
    "type": "executable",
    "win_delay_load_hook": "false",
    "sources": ["acl.cc"],
    "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0602"],
    "msvs_settings": {
      "VCCLCompilerTool": { "RuntimeLibrary": 0, "ExceptionHandling": 1 },
      "VCLinkerTool": { "SubSystem": 1 }
    },
    "libraries": ["-ladvapi32.lib"]
  },
  "targets": [
    { "target_name": "trellis_acl" },
    { "target_name": "trellis_acl_probe", "defines": ["TRELLIS_ACL_TESTING"] }
  ]
}
