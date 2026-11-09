{
  "targets": [{
    "target_name": "trellis_preserve",
    "type": "executable",
    "product_extension": "exe",
    "win_delay_load_hook": "false",
    "sources": ["preserve.cc"],
    "defines": ["UNICODE", "_UNICODE", "NOMINMAX", "_WIN32_WINNT=0x0602"],
    "libraries": ["-ladvapi32.lib", "-lshell32.lib", "-lole32.lib", "-luuid.lib"],
    "msvs_settings": {"VCCLCompilerTool": {"RuntimeLibrary": 0, "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"]}, "VCLinkerTool": {"SubSystem": 1}}
  }]
}
