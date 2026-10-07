// Spore Galactic Adventures: SporebinEP1/SporeApp.exe, loads Data and DataEP1, supports ModAPI mods
module.exports = {
    id: 'sporegalacticadventures',
    name: 'Spore Galactic Adventures',
    executable: 'SporebinEP1/SporeApp.exe',
    // default destination of .package files
    dataFolder: 'DataEP1',
    // Steam: Galactic Adventures (24720) has its own install now, older ones have it as a DLC inside Spore (17390).
    // The first id is also the one the exe needs to start
    steamAppIds: ['24720', '17390'],
    // DataDir of this key is <game>/DataEP1
    registryKey: 'Electronic Arts\\SPORE_EP1',
    // most Spore mods are uploaded to nexusmods.com/spore. Not a nexusPageId: Vortex would show
    // the artwork of the Spore section for this game and pick it over the Spore extension
    compatibleDownloads: ['spore'],
    modApi: true,
    otherExecutable: {
        id: 'SporeCore',
        name: 'Spore (without Galactic Adventures)',
        shortName: 'Spore',
        executable: 'SporeBin/SporeApp.exe',
    },
};
