// Spore without Galactic Adventures: SporeBin/SporeApp.exe, loads only Data, no ModAPI
module.exports = {
    id: 'spore',
    name: 'Spore',
    executable: 'SporeBin/SporeApp.exe',
    // default destination of .package files
    dataFolder: 'Data',
    steamAppIds: ['17390'],
    // DataDir of this key is <game>/Data
    registryKey: 'Electronic Arts\\SPORE',
    modApi: false,
    // mod type of mods with files outside Data. Must differ from the Galactic Adventures one
    modTypeRoot: 'spore-base-game-root',
    otherExecutable: {
        id: 'SporeGA',
        name: 'Spore Galactic Adventures',
        shortName: 'Spore GA',
        executable: 'SporebinEP1/SporeApp.exe',
    },
};
