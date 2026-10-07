# Spore Extensions for NexusMods Vortex

Two Vortex extensions built from the same `index.js`, `games/<id>/game.js` describes the game:
- **Spore Galactic Adventures** (`sporegalacticadventures`, [Nexus page](https://www.nexusmods.com/site/mods/2424)):
  `SporebinEP1/SporeApp.exe`, mods go to `DataEP1`, ModAPI mods supported
- **Spore** (`spore`, [Nexus page](https://www.nexusmods.com/site/mods/2423),
  [packaged extension repo](https://github.com/mitay-walle/vortex-spore)):
  `SporeBin/SporeApp.exe` without the expansion, mods go to `Data`.
  ModAPI mods are refused (ModAPI only works with Galactic Adventures),
  files meant for Galactic Adventures are installed to `DataEP1` with a warning

Downloads from nexusmods.com/spore belong to the Spore extension, Galactic Adventures declares them
compatible (`compatibleDownloads`), so they can be installed into it as well.

## Features
- Game detection: Steam (Galactic Adventures: its standalone app 24720 first, then Spore 17390), GOG,
  EA App / Origin / disc (registry `Electronic Arts\SPORE_EP1` / `Electronic Arts\SPORE`)
- "Mod Manager Download" works for mods from both [nexusmods.com/spore](https://www.nexusmods.com/spore)
  and nexusmods.com/sporegalacticadventures
- Archives with `.package` files are deployed to `DataEP1`
  (files inside a `Data` folder go to the core Spore `Data` folder)
- `.sporemod` files (loose download or inside an archive) are installed the same way as the
  Spore ModAPI Easy Installer does it, based on `ModInfo.xml`:
  prerequisites, optional components and component groups (asked in a dialog, remembered for reinstall),
  compat files, legacy `-disk` / `-steam_patched` DLLs
- ModAPI DLLs are deployed to `SporeModLoader/ModLibs` and loaded by
  [SporeModLoader](https://github.com/Rosalie241/SporeModLoader). When DLL mods are deployed without it,
  Vortex shows a notification that downloads and installs it as a regular mod
- 4GB patch: when `SporebinEP1/SporeApp.exe` is not Large Address Aware, Vortex offers to set the flag
  (the original is kept as `SporeApp.exe.vortex_backup`). Skipped for Steam executables, their SteamStub DRM breaks on a modified exe
- Tools: Spore without GA, Spore ModAPI Launcher (if the Launcher Kit is installed separately)

## Spore ModAPI Launcher Kit vs SporeModLoader
The Launcher Kit copies mod DLLs into its own folder, which Vortex can't manage,
and it refuses to start while SporeModLoader is installed. With this extension use SporeModLoader:
start the game from Vortex (or directly with `SporebinEP1/SporeApp.exe`), mods are injected by `dinput8.dll`.
Mods installed earlier with the Easy Installer should be uninstalled with the Easy Uninstaller first.

## Not supported
- `<remove>` entries of `ModInfo.xml` (Vortex tracks deployed files itself)
- Mods with a custom `Installer.exe` and no `ModInfo.xml` (their `.package`/`.dll` files are installed as is)
- Creations (`.png`) and saved games

## Development
- `build.ps1` packs `dist/game-<id>-<version>.zip` for both games for uploading to Nexus
- `build.ps1 -Install` copies both extensions into `%APPDATA%\Vortex\plugins\game-<id>`
- [Creating a game extension](https://github.com/Nexus-Mods/Vortex/wiki/LEGACY-General-Creating-a-game-extension/Home)

# TODO
- [x] Basic Implementation
- [x] `.sporemod` / ModAPI DLL support via SporeModLoader
- [ ] .ini files merging from different mods
