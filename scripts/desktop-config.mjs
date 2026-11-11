import { join } from 'node:path'

// Plain files keep native modules, utilityProcess workers and child-process
// supervisors on the same paths in development and packaged applications.
export function desktopConfig({ target, app, plugin, output, electronDist, electronVersion, format = 'default' }) {
  if (!['default', 'dir'].includes(format)) throw Error('Unsupported package format')
  return {
    appId: 'app.pliuna.desktop', productName: 'Pliuna',
    directories: { output }, electronDist, electronVersion,
    asar: false, npmRebuild: false, nodeGypRebuild: false,
    files: ['out/**/*', 'package.json', 'DESKTOP-BUILD.json'],
    // Copy the already audited flat closure verbatim. A second package-manager
    // crawl must not reintroduce optional targets or discard native files.
    extraResources: [{ from: join(app, 'node_modules'), to: 'app/node_modules' }, { from: plugin, to: 'reference-plugins/pdf-text' }],
    publish: null,
    mac: { target: format === 'dir' ? ['dir'] : ['zip'], identity: '-', notarize: false, category: 'public.app-category.productivity',
      // Monty's release binaries carry fixed runtime integrity metadata. Keep
      // their upstream signatures and bytes, as the legacy Mac packager does.
      signIgnore: ['/node_modules/@pydantic/'] },
    win: { target: format === 'dir' ? ['dir'] : ['nsis'], signAndEditExecutable: false },
    nsis: { oneClick: false, perMachine: false, selectPerMachineByDefault: false, allowElevation: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
    linux: { target: format === 'dir' ? ['dir'] : ['AppImage'], executableName: 'pliuna', category: 'Office' },
    artifactName: `Pliuna-\${version}-${target.id}.\${ext}`
  }
}

export function desktopPaths(output, target) {
  if (target.platform === 'darwin') {
    const bundle = join(output, `mac${target.arch === 'arm64' ? '-arm64' : ''}`, 'Pliuna.app')
    return { app: join(bundle, 'Contents/Resources/app'), executable: join(bundle, 'Contents/MacOS/Pliuna') }
  }
  const directory = join(output, target.platform === 'win32' ? 'win-unpacked' : `linux${target.arch === 'arm64' ? '-arm64' : ''}-unpacked`)
  return { app: join(directory, 'resources/app'), executable: join(directory, target.platform === 'win32' ? 'Pliuna.exe' : 'pliuna') }
}
