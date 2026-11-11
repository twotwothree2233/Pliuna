import catalog from './native-targets.json' with { type: 'json' }

export { catalog as nativeTargets }

// Target selection is independent of the build host and never assumes glibc.
export function montyTarget(platform, arch, libc = null) {
  return catalog.targets.find(target => target.platform === platform && target.arch === arch && target.libc === libc) ?? null
}

export function hostMontyTarget() {
  let libc = null
  if (process.platform === 'linux') {
    try {
      if (process.report.getReport().header.glibcVersionRuntime) libc = 'glibc'
    } catch { /* Unknown libc remains unsupported. No shell or PATH probe. */ }
  }
  return montyTarget(process.platform, process.arch, libc)
}
