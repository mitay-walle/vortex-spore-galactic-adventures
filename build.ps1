# Packs both extensions (Spore, Spore Galactic Adventures) into dist/ for uploading to Nexus Mods,
# or copies them into the local Vortex plugins folder with -Install
param([switch]$Install)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$shared = 'index.js', 'modapi-launcher.png'

foreach ($game in Get-ChildItem (Join-Path $root 'games') -Directory) {
    $files = @($shared | ForEach-Object { Join-Path $root $_ }) +
        @('game.js', 'info.json', 'gameart.png' | ForEach-Object { Join-Path $game.FullName $_ })
    $version = (Get-Content (Join-Path $game.FullName 'info.json') -Raw | ConvertFrom-Json).version
    $name = "game-$($game.Name)"

    if ($Install) {
        $target = Join-Path $env:APPDATA "Vortex\plugins\$name"
        New-Item -ItemType Directory -Force $target | Out-Null
        foreach ($file in $files) { Copy-Item $file $target -Force }
        Write-Output "Installed $name $version to $target"
        continue
    }

    $dist = Join-Path $root 'dist'
    New-Item -ItemType Directory -Force $dist | Out-Null
    $zip = Join-Path $dist "$name-$version.zip"
    Compress-Archive -Path $files -DestinationPath $zip -Force
    Write-Output $zip
}
if ($Install) { Write-Output 'Restart Vortex to load the extensions' }
