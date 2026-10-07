// Vortex game extension for Spore and Spore Galactic Adventures.
// The same file is shipped in both extensions, game.js next to it describes the game.
//
// Supported mod formats:
//  - archives with loose .package files      -> the game's data folder (or Data / DataEP1, if the archive says so)
//  - .sporemod (zip with ModInfo.xml), loose or nested inside an archive
//    .package files -> DataEP1 / Data, ModAPI .dll files -> SporeModLoader/ModLibs (Galactic Adventures only)
//  - SporeModLoader itself (https://github.com/Rosalie241/SporeModLoader),
//    which injects ModAPI DLLs from the game folder, so Vortex can deploy them
const path = require('path');
const https = require('https');
const { actions, fs, log, selectors, util } = require('vortex-api');
const winapi = require('winapi-bindings');
const GAME = require('./game.js');

const GAME_ID = GAME.id;
const GOGAPP_ID = '1948823323';

const GA_DATA = 'DataEP1';
const CORE_DATA = 'Data';
const GAME_EXE = path.normalize(GAME.executable);
const MOD_LIBS = path.join('SporeModLoader', 'ModLibs');
const SML_PROXY = path.join('SporebinEP1', 'dinput8.dll');

// Values of the "game" attribute in ModInfo.xml
const XML_GAME_GA = 'galacticadventures';
const XML_GAME_SPORE = 'spore';

// must differ between both Spore extensions, Vortex looks mod types up by id only (see game.js)
const MODTYPE_ROOT = GAME.modTypeRoot;
const SPOREMOD_EXTRACT_DIR = '__sporemod';
const NOTIF_SML_MISSING = `${GAME_ID}-sporemodloader-missing`;
const NOTIF_LAA = `${GAME_ID}-large-address-aware`;
const NOTIF_GA_CONTENT = `${GAME_ID}-ga-content`;

// PE header flag that lets the 32 bit game use 4 GB instead of 2 GB of memory ("4GB patch")
const PE_HEADER_POINTER = 0x3C;
const PE_CHARACTERISTICS_OFFSET = 0x16;
const IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x20;
// Steam builds are wrapped in SteamStub DRM (".bind" section) and don't start after any modification
const STEAMSTUB_SECTION = '.bind';
const EXE_BACKUP_SUFFIX = '.vortex_backup';

const SML_RELEASE_API = 'https://api.github.com/repos/Rosalie241/SporeModLoader/releases/tags/rolling-release';
const SML_RELEASES_PAGE = 'https://github.com/Rosalie241/SporeModLoader/releases';
// "SMALauncher" is the id used by extension versions before 0.1.0
const LAUNCHER_KIT_TOOL_IDS = ['SporeModAPILauncher', 'SMALauncher'];
const LAUNCHER_KIT_PATH_INFO = path.join(process.env.APPDATA || '', 'Spore ModAPI Launcher', 'path.info');

const tools = [
    {
        id: GAME.otherExecutable.id,
        name: GAME.otherExecutable.name,
        shortName: GAME.otherExecutable.shortName,
        logo: 'gameart.png',
        executable: () => path.normalize(GAME.otherExecutable.executable),
        requiredFiles: [path.normalize(GAME.otherExecutable.executable)],
        relative: true,
    },
];
if (GAME.modApi) {
    tools.push({
        // Only found when the Launcher Kit is installed separately. It refuses to start while
        // SporeModLoader is deployed, use one or the other.
        id: 'SporeModAPILauncher',
        name: 'Spore ModAPI Launcher',
        shortName: 'ModAPI',
        logo: 'modapi-launcher.png',
        executable: () => 'Spore ModAPI Launcher.exe',
        requiredFiles: ['Spore ModAPI Launcher.exe'],
        queryPath: findLauncherKit,
        detach: true,
    });
}

function main(context) {
    context.registerGame({
        id: GAME_ID,
        name: GAME.name,
        mergeMods: true,
        queryPath: findGame,
        supportedTools: tools,
        queryModPath: () => GAME.dataFolder,
        logo: 'gameart.png',
        executable: () => GAME_EXE,
        requiredFiles: [GAME_EXE],
        setup: discovery => prepareForModding(context.api, discovery),
        environment: {
            SteamAPPId: GAME.steamAppIds[0],
        },
        details: {
            // the own app id, Vortex uses it for the artwork of the game
            steamAppId: +GAME.steamAppIds[0],
            gogAppId: GOGAPP_ID,
            nexusPageId: GAME.nexusPageId,
            compatibleDownloads: GAME.compatibleDownloads,
        },
    });

    // Destinations of this type are relative to the game folder (DataEP1/..., SporeModLoader/...)
    context.registerModType(MODTYPE_ROOT, 25, gameId => gameId === GAME_ID,
        game => selectors.discoveryByGame(context.api.getState(), game.id)?.path, () => Promise.resolve(false),
        { name: 'Spore game folder' });

    if (GAME.modApi) {
        context.registerInstaller(`${GAME_ID}-sporemodloader`, 20, testSporeModLoader, installSporeModLoader);
    }
    context.registerInstaller(`${GAME_ID}-sporemod`, 25, testSporeMod,
        (files, destinationPath, gameId, progress, choices, unattended) =>
            installSporeMod(context.api, files, destinationPath, choices, unattended));

    if (GAME.modApi) {
        context.once(() => {
            context.api.onAsync('did-deploy', profileId => {
                const profile = selectors.profileById(context.api.getState(), profileId);
                return profile?.gameId === GAME_ID
                    ? checkSporeModLoader(context.api)
                    : Promise.resolve();
            });
        });
    }

    return true;
}

// ---------------------------------------------------------------- discovery

function readRegistry(key, value) {
    for (const prefix of ['SOFTWARE\\WOW6432Node\\', 'SOFTWARE\\']) {
        try {
            const result = winapi.RegGetValue('HKEY_LOCAL_MACHINE', prefix + key, value);
            if (typeof result?.value === 'string' && result.value.length > 0) {
                return result.value.replace(/^"|"$/g, '');
            }
        } catch (err) {
            // key missing, try the next one
        }
    }
    return undefined;
}

async function isGameFolder(gamePath) {
    try {
        await fs.statAsync(path.join(gamePath, GAME_EXE));
        return true;
    } catch (err) {
        return false;
    }
}

async function findGame() {
    // one id at a time, the first ids are preferred
    for (const appId of [...GAME.steamAppIds, GOGAPP_ID]) {
        try {
            const game = await util.GameStoreHelper.findByAppId([appId]);
            if (await isGameFolder(game.gamePath)) {
                return game.gamePath;
            }
        } catch (err) {
            // not installed in this store
        }
    }

    // EA App / Origin / disc installs. DataDir is what the game itself uses to find its packages.
    const dataDir = readRegistry(GAME.registryKey, 'DataDir');
    const candidates = [
        dataDir !== undefined ? path.dirname(path.resolve(dataDir)) : undefined,
        readRegistry('GOG.com\\Games\\' + GOGAPP_ID, 'path'),
    ].filter(candidate => candidate !== undefined);

    for (const candidate of candidates) {
        if (await isGameFolder(candidate)) {
            return candidate;
        }
    }
    throw new util.GameNotFound(GAME_ID);
}

async function findLauncherKit() {
    const kitPath = (await fs.readFileAsync(LAUNCHER_KIT_PATH_INFO, { encoding: 'utf8' })).trim();
    await fs.statAsync(path.join(kitPath, 'Spore ModAPI Launcher.exe'));
    return kitPath;
}

function getGamePath(api) {
    return selectors.discoveryByGame(api.getState(), GAME_ID)?.path;
}

async function prepareForModding(api, discovery) {
    await fs.ensureDirWritableAsync(path.join(discovery.path, GAME.dataFolder));
    if (GAME.modApi) {
        await checkSporeModLoader(api);
    }
    await checkLargeAddressAware(api, discovery.path);
}

// ---------------------------------------------------------------- 4GB patch

function laaFlagOffset(exe) {
    return exe.readUInt32LE(PE_HEADER_POINTER) + PE_CHARACTERISTICS_OFFSET;
}

function hasSteamStub(exe) {
    const peHeader = exe.readUInt32LE(PE_HEADER_POINTER);
    const sectionCount = exe.readUInt16LE(peHeader + 6);
    const firstSection = peHeader + 24 + exe.readUInt16LE(peHeader + 20);
    for (let idx = 0; idx < sectionCount; ++idx) {
        const offset = firstSection + idx * 40;
        if (exe.toString('latin1', offset, offset + 8).replace(/\0+$/, '') === STEAMSTUB_SECTION) {
            return true;
        }
    }
    return false;
}

// Without the flag Spore crashes with out of memory errors as soon as HD textures or many mods are installed
async function checkLargeAddressAware(api, gamePath) {
    const exePath = path.join(gamePath, GAME_EXE);
    let exe;
    try {
        exe = await fs.readFileAsync(exePath);
    } catch (err) {
        log('warn', 'failed to read game executable', err.message);
        return;
    }
    if ((exe.readUInt16LE(laaFlagOffset(exe)) & IMAGE_FILE_LARGE_ADDRESS_AWARE) !== 0 || hasSteamStub(exe)) {
        api.dismissNotification(NOTIF_LAA);
        return;
    }

    api.sendNotification({
        id: NOTIF_LAA,
        type: 'warning',
        title: `${GAME.name} can only use 2 GB of memory`,
        message: 'This causes crashes with HD textures and big mods. Apply the 4GB patch (Large Address Aware)?',
        actions: [
            { title: 'Apply', action: dismiss => applyLargeAddressAware(api, exePath).then(dismiss) },
        ],
    });
}

async function applyLargeAddressAware(api, exePath) {
    try {
        const exe = await fs.readFileAsync(exePath);
        const offset = laaFlagOffset(exe);
        exe.writeUInt16LE(exe.readUInt16LE(offset) | IMAGE_FILE_LARGE_ADDRESS_AWARE, offset);
        const backupPath = exePath + EXE_BACKUP_SUFFIX;
        try {
            await fs.statAsync(backupPath);
        } catch (err) {
            await fs.copyAsync(exePath, backupPath);
        }
        await fs.writeFileAsync(exePath, exe);
        api.sendNotification({
            type: 'success',
            message: `4GB patch applied, the original executable is saved as ${path.basename(backupPath)}`,
            displayMS: 5000,
        });
    } catch (err) {
        api.showErrorNotification('Failed to apply the 4GB patch', err, { allowReport: false });
    }
}

// ---------------------------------------------------------------- SporeModLoader

async function folderHasDlls(folder) {
    try {
        const entries = await fs.readdirAsync(folder);
        return entries.some(entry => path.extname(entry).toLowerCase() === '.dll');
    } catch (err) {
        return false;
    }
}

// The Launcher Kit refuses to start while SporeModLoader is installed, so "Play" has to start the game itself.
// Older versions of this extension made the Launcher Kit ("SMALauncher") the primary tool.
function resetLauncherKitPrimaryTool(api) {
    const primaryTool = api.getState().settings.interface.primaryTool?.[GAME_ID];
    if (LAUNCHER_KIT_TOOL_IDS.includes(primaryTool)) {
        api.store.dispatch(actions.setPrimaryTool(GAME_ID, undefined));
        api.sendNotification({
            type: 'info',
            message: 'SporeModLoader is installed, "Play" now starts the game directly instead of the Spore ModAPI Launcher',
            displayMS: 8000,
        });
    }
}

// Warn when ModAPI DLLs are deployed but nothing will load them
async function checkSporeModLoader(api) {
    const gamePath = getGamePath(api);
    if (gamePath === undefined) {
        return;
    }
    let loaderPresent = true;
    try {
        await fs.statAsync(path.join(gamePath, SML_PROXY));
    } catch (err) {
        loaderPresent = false;
    }

    if (loaderPresent) {
        resetLauncherKitPrimaryTool(api);
    }
    if (loaderPresent || !(await folderHasDlls(path.join(gamePath, MOD_LIBS)))) {
        api.dismissNotification(NOTIF_SML_MISSING);
        return;
    }

    api.sendNotification({
        id: NOTIF_SML_MISSING,
        type: 'warning',
        title: 'SporeModLoader is required',
        message: 'Some installed mods contain ModAPI DLLs, they need SporeModLoader to work.',
        actions: [
            { title: 'Install', action: () => downloadSporeModLoader(api) },
            { title: 'Open page', action: () => util.opn(SML_RELEASES_PAGE).catch(() => null) },
        ],
    });
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Vortex-Spore-Extension' } }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`GET ${url} failed: HTTP ${res.statusCode}`));
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

async function downloadSporeModLoader(api) {
    api.dismissNotification(NOTIF_SML_MISSING);
    try {
        const release = await getJson(SML_RELEASE_API);
        // the release also contains a macOS build
        const asset = (release.assets || []).find(iter => /^SporeModLoader-[0-9a-f]+\.zip$/i.test(iter.name));
        if (asset === undefined) {
            throw new Error('SporeModLoader release has no Windows archive');
        }
        const dlId = await util.toPromise(cb => api.events.emit('start-download',
            [asset.browser_download_url], { game: GAME_ID, name: 'SporeModLoader' },
            asset.name, cb, 'replace', { allowInstall: false }));
        const modId = await util.toPromise(cb =>
            api.events.emit('start-install-download', dlId, { allowAutoEnable: false }, cb));
        const profileId = selectors.lastActiveProfileForGame(api.getState(), GAME_ID);
        await actions.setModsEnabled(api, profileId, [modId], true, {
            allowAutoDeploy: true,
            installed: true,
        });
    } catch (err) {
        if (err instanceof util.UserCanceled) {
            return;
        }
        api.showErrorNotification('Failed to install SporeModLoader', err, { allowReport: false });
        util.opn(SML_RELEASES_PAGE).catch(() => null);
    }
}

// SporeModLoader release layout: SporebinEP1/dinput8.dll, SporeModLoader/CoreLibs/..., SporeModLoader/ModLibs/
function findSporeModLoaderRoot(files) {
    const proxy = files.find(file => file.toLowerCase().endsWith(SML_PROXY.toLowerCase()));
    if (proxy === undefined) {
        return undefined;
    }
    const root = proxy.slice(0, proxy.length - SML_PROXY.length);
    const hasCoreLibs = files.some(file =>
        file.toLowerCase().startsWith((root + path.join('SporeModLoader', 'CoreLibs')).toLowerCase()));
    return hasCoreLibs ? root : undefined;
}

function testSporeModLoader(files, gameId) {
    return Promise.resolve({
        supported: gameId === GAME_ID && findSporeModLoaderRoot(files) !== undefined,
        requiredFiles: [],
    });
}

function installSporeModLoader(files) {
    const root = findSporeModLoaderRoot(files);
    const instructions = files
        .filter(file => !file.endsWith(path.sep) && file.startsWith(root))
        .map(file => ({ type: 'copy', source: file, destination: file.slice(root.length) }));
    instructions.push({ type: 'setmodtype', value: MODTYPE_ROOT });
    return Promise.resolve({ instructions });
}

// ---------------------------------------------------------------- ModInfo.xml

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decodeXml(text) {
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === '#') {
            return String.fromCodePoint(entity[1].toLowerCase() === 'x'
                ? parseInt(entity.slice(2), 16)
                : parseInt(entity.slice(1), 10));
        }
        return XML_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

// ModInfo.xml is a small, flat document, a tiny parser is enough and works outside of a browser
function parseXml(text) {
    const root = { name: '#document', attributes: {}, children: [], text: '' };
    const stack = [root];
    const tokenizer = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    const attribute = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = tokenizer.exec(text)) !== null) {
        const [, cdata, closing, opening, attributes, selfClosing, chars] = match;
        const current = stack[stack.length - 1];
        if (cdata !== undefined) {
            current.text += cdata;
        } else if (chars !== undefined) {
            current.text += decodeXml(chars);
        } else if (closing !== undefined) {
            if (stack.length > 1) {
                stack.pop();
            }
        } else if (opening !== undefined) {
            const node = { name: opening, attributes: {}, children: [], text: '' };
            let attr;
            while ((attr = attribute.exec(attributes)) !== null) {
                node.attributes[attr[1].toLowerCase()] = decodeXml(attr[3] ?? attr[4]);
            }
            current.children.push(node);
            if (selfClosing !== '/') {
                stack.push(node);
            }
        }
    }
    const mod = root.children.find(node => node.name.toLowerCase() === 'mod');
    if (mod === undefined) {
        throw new util.DataInvalid('ModInfo.xml has no <mod> element');
    }
    return mod;
}

function splitList(value) {
    return (value ?? '').split('?').map(item => item.trim());
}

function parseComponent(node) {
    const attrs = node.attributes;
    const files = splitList(node.text).filter(file => file.length > 0);
    const games = splitList(attrs.game);
    return {
        unique: attrs.unique,
        displayName: attrs.displayname ?? attrs.unique ?? files.join(', '),
        description: attrs.description ?? '',
        defaultChecked: (attrs.defaultchecked ?? '').toLowerCase() === 'true',
        files: files.map((name, idx) => ({ name, game: (games[idx] ?? '').toLowerCase() })),
        compatTargets: splitList(attrs.compattargetfilename)
            .map((name, idx) => ({ name, game: (splitList(attrs.compattargetgame)[idx] ?? '').toLowerCase() }))
            .filter(target => target.name.length > 0),
    };
}

function parseModInfo(text) {
    const mod = parseXml(text);
    const info = {
        attributes: mod.attributes,
        prerequisites: [],
        components: [],
        groups: [],
        compatFiles: [],
    };
    for (const node of mod.children) {
        switch (node.name.toLowerCase()) {
            case 'prerequisite': info.prerequisites.push(parseComponent(node)); break;
            case 'component': info.components.push(parseComponent(node)); break;
            case 'compatfile': info.compatFiles.push(parseComponent(node)); break;
            case 'componentgroup':
                info.groups.push({
                    unique: node.attributes.unique,
                    displayName: node.attributes.displayname ?? node.attributes.unique,
                    components: node.children
                        .filter(child => child.name.toLowerCase() === 'component')
                        .map(parseComponent),
                });
                break;
            case 'remove':
                // deletes leftovers of older installs, Vortex keeps track of deployed files itself
                break;
            default:
                log('debug', 'ignoring ModInfo.xml element', node.name);
        }
    }
    return info;
}

// ---------------------------------------------------------------- installer

const isDir = file => file.endsWith(path.sep);
const extOf = file => path.extname(file).toLowerCase();

function testSporeMod(files, gameId) {
    const supported = gameId === GAME_ID && files.some(file =>
        ['.package', '.sporemod', '.dll'].includes(extOf(file))
        || path.basename(file).toLowerCase() === 'modinfo.xml');
    return Promise.resolve({ supported, requiredFiles: [] });
}

// Destination relative to the game folder
function destinationFor(fileName, game) {
    if (game === XML_GAME_GA) {
        return path.join(GA_DATA, fileName);
    }
    if (game === XML_GAME_SPORE) {
        return path.join(CORE_DATA, fileName);
    }
    return extOf(fileName) === '.dll'
        ? path.join(MOD_LIBS, fileName)
        : path.join(GAME.dataFolder, fileName);
}

// Loose .package in an archive: honour an explicit "Data" / "DataEP1" folder,
// everything else goes to the data folder of this game
function looseDestination(file) {
    const fileName = path.basename(file);
    if (extOf(file) === '.dll') {
        return path.join(MOD_LIBS, fileName);
    }
    const folders = path.dirname(file).toLowerCase().split(path.sep);
    if (folders.includes(GA_DATA.toLowerCase())) {
        return path.join(GA_DATA, fileName);
    }
    return folders.includes(CORE_DATA.toLowerCase())
        ? path.join(CORE_DATA, fileName)
        : path.join(GAME.dataFolder, fileName);
}

async function listFilesRecursive(basePath, relPath = '') {
    const result = [];
    for (const entry of await fs.readdirAsync(path.join(basePath, relPath))) {
        const entryRel = path.join(relPath, entry);
        const stats = await fs.statAsync(path.join(basePath, entryRel));
        if (stats.isDirectory()) {
            result.push(...(await listFilesRecursive(basePath, entryRel)));
        } else {
            result.push(entryRel);
        }
    }
    return result;
}

async function extractSporemod(destinationPath, sporemodFile) {
    const relDir = path.join(SPOREMOD_EXTRACT_DIR, path.basename(sporemodFile, path.extname(sporemodFile)));
    const szip = new util.SevenZip();
    await szip.extractFull(path.join(destinationPath, sporemodFile), path.join(destinationPath, relDir), { ssc: false });
    return (await listFilesRecursive(destinationPath, relDir));
}

function legacyDllVariants(fileName, byName) {
    // installerSystemVersion 1.0.0.0 ships one DLL per game build; SporeModLoader picks the right one
    if (/-(disk|steam|steam_patched)\.dll$/i.test(fileName)) {
        return [fileName];
    }
    const base = fileName.slice(0, -'.dll'.length);
    return [fileName, `${base}-disk.dll`, `${base}-steam.dll`, `${base}-steam_patched.dll`]
        .filter(name => byName.has(name.toLowerCase()));
}

async function compatTargetsExist(gamePath, compat) {
    if (gamePath === undefined) {
        return false;
    }
    for (const target of compat.compatTargets) {
        try {
            await fs.statAsync(path.join(gamePath, destinationFor(target.name, target.game)));
        } catch (err) {
            return false;
        }
    }
    return true;
}

async function askComponents(api, modName, info, stored, unattended) {
    const selected = new Set();
    const showChooser = info.isLegacy
        ? info.attributes.mode !== 'compatOnly'
        : (info.attributes.hascustominstaller ?? '').toLowerCase() === 'true';
    if (!showChooser) {
        return selected;
    }

    const defaults = new Set([
        ...info.components.filter(comp => comp.defaultChecked),
        ...info.groups.map(group => group.components.find(comp => comp.defaultChecked) ?? group.components[0]),
    ].filter(comp => comp !== undefined).map(comp => comp.unique));

    if (stored !== undefined || unattended) {
        return new Set(stored ?? defaults);
    }

    const describe = comps => comps
        .filter(comp => comp.description.length > 0)
        .map(comp => `[b]${comp.displayName}[/b]: ${comp.description}`)
        .join('[br][/br]');

    if (info.components.length > 0) {
        const result = await api.showDialog('question', `${modName}: components`, {
            bbcode: describe(info.components),
            checkboxes: info.components.map(comp =>
                ({ id: comp.unique, text: comp.displayName, value: defaults.has(comp.unique) })),
        }, [{ label: 'Cancel' }, { label: 'Continue', default: true }]);
        if (result.action === 'Cancel') {
            throw new util.UserCanceled();
        }
        Object.keys(result.input).filter(id => result.input[id]).forEach(id => selected.add(id));
    }

    for (const group of info.groups) {
        const result = await api.showDialog('question', `${modName}: ${group.displayName}`, {
            bbcode: describe(group.components),
            choices: group.components.map(comp =>
                ({ id: comp.unique, text: comp.displayName, value: defaults.has(comp.unique) })),
        }, [{ label: 'Cancel' }, { label: 'Continue', default: true }]);
        if (result.action === 'Cancel') {
            throw new util.UserCanceled();
        }
        Object.keys(result.input).filter(id => result.input[id]).forEach(id => selected.add(id));
    }
    return selected;
}

// files: paths relative to destinationPath that belong to one .sporemod
async function sporemodInstructions(api, destinationPath, files, storedChoices, unattended) {
    const byName = new Map(files.filter(file => !isDir(file))
        .map(file => [path.basename(file).toLowerCase(), file]));
    const modInfoFile = byName.get('modinfo.xml');

    if (modInfoFile === undefined) {
        // sporemod without installer, like the Easy Installer: route every file by its extension
        return {
            name: undefined,
            selected: [],
            copies: Array.from(byName.values())
                .filter(file => ['.package', '.dll'].includes(extOf(file)))
                .map(file => ({ source: file, destination: looseDestination(path.basename(file)) })),
        };
    }

    const info = parseModInfo(await fs.readFileAsync(path.join(destinationPath, modInfoFile), { encoding: 'utf8' }));
    info.isLegacy = (info.attributes.installersystemversion ?? '1.0.0.0') === '1.0.0.0';
    const name = info.attributes.unique ?? info.attributes.displayname ?? path.basename(path.dirname(modInfoFile));
    const displayName = info.attributes.displayname ?? name;
    if (!GAME.modApi) {
        // fail before asking for components, the mod can't work anyway
        checkGalacticAdventuresContent(api, info.prerequisites.flatMap(comp => comp.files)
            .map(file => destinationFor(file.name, file.game).toLowerCase()));
    }

    const selected = await askComponents(api, displayName, info, storedChoices?.[name], unattended);
    const chosen = [
        ...info.prerequisites,
        ...info.components.filter(comp => selected.has(comp.unique)),
        ...info.groups.flatMap(group => group.components.filter(comp => selected.has(comp.unique))),
    ];
    const gamePath = getGamePath(api);
    for (const compat of info.compatFiles) {
        if (await compatTargetsExist(gamePath, compat)) {
            chosen.push(compat);
        }
    }

    const copies = [];
    for (const { name: fileName, game } of chosen.flatMap(comp => comp.files)) {
        const isModLib = extOf(fileName) === '.dll' && ![XML_GAME_GA, XML_GAME_SPORE].includes(game);
        const names = isModLib && info.isLegacy ? legacyDllVariants(fileName, byName) : [fileName];
        for (const actual of names) {
            const source = byName.get(actual.toLowerCase());
            if (source === undefined) {
                log('warn', 'file listed in ModInfo.xml is missing', { mod: name, file: actual });
                continue;
            }
            copies.push({ source, destination: destinationFor(path.basename(source), game) });
        }
    }
    return { name, selected: Array.from(selected), copies };
}

// Spore without GA loads neither DataEP1 nor ModAPI DLLs
function checkGalacticAdventuresContent(api, destinations) {
    if (destinations.some(dest => dest.startsWith(MOD_LIBS.toLowerCase() + path.sep))) {
        throw new util.DataInvalid('This mod needs Spore ModAPI, which only works with Galactic Adventures. '
            + 'Manage "Spore Galactic Adventures" in Vortex to install it.');
    }
    if (destinations.some(dest => dest.startsWith(GA_DATA.toLowerCase() + path.sep))) {
        api.sendNotification({
            id: NOTIF_GA_CONTENT,
            type: 'warning',
            message: 'Some files of this mod are for Galactic Adventures (DataEP1), Spore without GA ignores them',
        });
    }
}

async function installSporeMod(api, files, destinationPath, choices, unattended) {
    const storedChoices = choices?.type === 'sporemod' ? choices.components : undefined;
    const plainFiles = files.filter(file => !isDir(file));
    const results = [];

    const modInfo = plainFiles.find(file => path.basename(file).toLowerCase() === 'modinfo.xml');
    if (modInfo !== undefined) {
        // an extracted .sporemod (downloaded or dropped directly)
        const root = path.dirname(modInfo);
        const own = plainFiles.filter(file => path.dirname(file) === root);
        results.push(await sporemodInstructions(api, destinationPath, own, storedChoices, unattended));
    } else {
        for (const sporemod of plainFiles.filter(file => extOf(file) === '.sporemod')) {
            const extracted = await extractSporemod(destinationPath, sporemod);
            results.push(await sporemodInstructions(api, destinationPath, extracted, storedChoices, unattended));
        }
        results.push({
            copies: plainFiles
                .filter(file => ['.package', '.dll'].includes(extOf(file)))
                .map(file => ({ source: file, destination: looseDestination(file) })),
        });
    }

    // the same file may be shipped loose and inside a .sporemod, keep one copy per destination
    const copies = new Map();
    results.flatMap(result => result.copies)
        .forEach(copy => copies.set(copy.destination.toLowerCase(), copy));
    if (copies.size === 0) {
        throw new util.DataInvalid('No Spore mod files (.package, .sporemod, .dll) found in this archive');
    }
    if (!GAME.modApi) {
        checkGalacticAdventuresContent(api, Array.from(copies.keys()));
    }

    const instructions = Array.from(copies.values())
        .map(copy => ({ type: 'copy', source: copy.source, destination: copy.destination }));
    instructions.push({ type: 'setmodtype', value: MODTYPE_ROOT });

    const components = results.filter(result => result.name !== undefined)
        .reduce((prev, result) => ({ ...prev, [result.name]: result.selected }), {});
    if (Object.keys(components).length > 0) {
        instructions.push({ type: 'attribute', key: 'installerChoices', value: { type: 'sporemod', components } });
    }
    return { instructions };
}

module.exports = {
    default: main,
    // exported for tests
    _internal: { parseModInfo, installSporeMod, installSporeModLoader, testSporeModLoader, testSporeMod },
};
