{
  "targets": [
    {
      "target_name": "trellis_acl",
      "type": "executable",
      "product_extension": "exe",
      "win_delay_load_hook": "false",
      "sources": [
        "acl.cc"
      ],
      "defines": [
        "UNICODE",
        "_UNICODE",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "_WIN32_WINNT=0x0602"
      ],
      "configurations": {
        "Release": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0,
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                "/EHsc"
              ]
            },
            "VCLinkerTool": {
              "SubSystem": 1
            }
          }
        },
        "Debug": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0,
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                "/EHsc"
              ]
            },
            "VCLinkerTool": {
              "SubSystem": 1
            }
          }
        }
      },
      "libraries": [
        "-ladvapi32.lib"
      ]
    },
    {
      "target_name": "trellis_acl_probe",
      "type": "executable",
      "product_extension": "exe",
      "win_delay_load_hook": "false",
      "sources": [
        "acl.cc"
      ],
      "defines": [
        "UNICODE",
        "_UNICODE",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "_WIN32_WINNT=0x0602",
        "TRELLIS_ACL_TESTING"
      ],
      "configurations": {
        "Release": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0,
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                "/EHsc"
              ]
            },
            "VCLinkerTool": {
              "SubSystem": 1
            }
          }
        },
        "Debug": {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0,
              "ExceptionHandling": 1,
              "AdditionalOptions": [
                "/EHsc"
              ]
            },
            "VCLinkerTool": {
              "SubSystem": 1
            }
          }
        }
      },
      "libraries": [
        "-ladvapi32.lib"
      ]
    }
  ]
}
