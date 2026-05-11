#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');
const {
    appRoot,
    resolveResource,
} = require('./runtime-paths');

const projectRoot = appRoot;
const protoDir = resolveResource('proto');
const externalProtoDir = resolveResource('qq-farm-bot-ui', 'core', 'src', 'proto');
const gameConfigDir = resolveResource('game-config');

const PLANT_PHASE = {
    UNKNOWN: 0,
    SEED: 1,
    GERMINATION: 2,
    SMALL_LEAVES: 3,
    LARGE_LEAVES: 4,
    BLOOMING: 5,
    MATURE: 6,
    DEAD: 7,
};

const PHASE_NAMES = {
    0: 'unknown',
    1: 'seed',
    2: 'germination',
    3: 'small_leaves',
    4: 'large_leaves',
    5: 'blooming',
    6: 'mature',
    7: 'dead',
};

const PHASE_LABELS_ZH = {
    unknown: '未知',
    seed: '种子',
    germination: '发芽',
    small_leaves: '小叶',
    large_leaves: '大叶',
    blooming: '开花',
    mature: '成熟',
    dead: '枯萎',
    empty: '空地',
};

const STATUS_LABELS_ZH = {
    locked: '未解锁',
    empty: '空地',
    growing: '生长中',
    harvestable: '可收获',
    dead: '枯萎',
};

function usage() {
    process.stdout.write('Usage: node src/index.js <path-to-bin> [--raw-json] [--pretty-json] [--cn-json] [--html] [--out output.html]\n');
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        input: '',
        rawJson: false,
        prettyJson: false,
        cnJson: false,
        html: false,
        out: '',
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') continue;
        if (arg === '--raw-json') {
            options.rawJson = true;
            continue;
        }
        if (arg === '--pretty-json') {
            options.prettyJson = true;
            continue;
        }
        if (arg === '--cn-json') {
            options.cnJson = true;
            continue;
        }
        if (arg === '--html') {
            options.html = true;
            continue;
        }
        if (arg === '--out') {
            const next = args[i + 1];
            if (!next || next.startsWith('--')) {
                process.stderr.write('Missing value for --out\n');
                process.exit(1);
            }
            options.out = path.resolve(process.cwd(), next);
            i++;
            continue;
        }
        if (arg.startsWith('--out=')) {
            options.out = path.resolve(process.cwd(), arg.slice('--out='.length));
            continue;
        }
        if (!options.input) {
            options.input = path.resolve(process.cwd(), arg);
        }
    }

    if (!options.input) {
        usage();
        process.exit(1);
    }

    return options;
}

function toNum(value) {
    if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
        return value.toNumber();
    }
    return Number(value || 0);
}

function toTimeSec(value) {
    const n = toNum(value);
    if (n <= 0) return 0;
    if (n > 1e12) return Math.floor(n / 1000);
    return n;
}

function formatTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}h ${m}m ${ss}s`;
    if (m > 0) return `${m}m ${ss}s`;
    return `${ss}s`;
}

function formatDateTimeFromSec(sec) {
    const timeSec = Math.max(0, Number(sec) || 0);
    if (!timeSec) return '';
    return new Date(timeSec * 1000).toLocaleString('zh-CN', { hour12: false });
}

function getDefaultHtmlOutputPath(inputFile) {
    const dir = path.dirname(inputFile);
    const ext = path.extname(inputFile);
    const base = path.basename(inputFile, ext);
    return path.join(dir, `${base}.html`);
}

function ensureDirForFile(file) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getRelativeAssetPath(outputFile, assetPath) {
    if (!assetPath) return '';
    const normalized = String(assetPath).replace(/\\/g, '/');
    if (!normalized.startsWith('./')) return normalized;
    const abs = path.resolve(projectRoot, normalized.slice(2));
    let rel = path.relative(path.dirname(outputFile), abs).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel;
}

function loadJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadGameConfig() {
    const plantList = loadJson(path.join(gameConfigDir, 'Plant.json'));
    const itemList = loadJson(path.join(gameConfigDir, 'ItemInfo.json'));

    const plantById = new Map();
    const seedImageById = new Map();
    const seedAssetImage = new Map();
    const itemById = new Map();

    for (const plant of plantList) {
        plantById.set(Number(plant.id) || 0, plant);
    }

    for (const item of itemList) {
        const id = Number(item && item.id) || 0;
        if (id > 0) itemById.set(id, item);
    }

    const seedDir = path.join(gameConfigDir, 'seed_images_named');
    if (fs.existsSync(seedDir)) {
        for (const file of fs.readdirSync(seedDir)) {
            const direct = file.match(/^(\d+)_.*\.(?:png|jpg|jpeg|webp|gif)$/i);
            if (direct) {
                const seedId = Number(direct[1]) || 0;
                if (seedId > 0 && !seedImageById.has(seedId)) {
                    seedImageById.set(seedId, `./game-config/seed_images_named/${file}`);
                }
            }

            const asset = file.match(/(Crop_\d+)_Seed\.(?:png|jpg|jpeg|webp|gif)$/i);
            if (asset && !seedAssetImage.has(asset[1])) {
                seedAssetImage.set(asset[1], `./game-config/seed_images_named/${file}`);
            }
        }
    }

    function getPlantById(plantId) {
        return plantById.get(Number(plantId) || 0) || null;
    }

    function getPlantName(plantId) {
        const plant = getPlantById(plantId);
        if (!plant) return '';
        return String(plant.name || '').trim();
    }

    function getSeedImageBySeedId(seedId) {
        const direct = seedImageById.get(Number(seedId) || 0);
        if (direct) return direct;

        const item = itemById.get(Number(seedId) || 0);
        const assetName = item && item.asset_name ? String(item.asset_name).trim() : '';
        return assetName ? (seedAssetImage.get(assetName) || '') : '';
    }

    function getItemById(itemId) {
        return itemById.get(Number(itemId) || 0) || null;
    }

    return {
        getPlantById,
        getPlantName,
        getSeedImageBySeedId,
        getItemById,
    };
}

async function loadProto() {
    const root = new protobuf.Root();
    const chosenProtoDir = fs.existsSync(externalProtoDir) ? externalProtoDir : protoDir;
    const protoFiles = fs.readdirSync(chosenProtoDir)
        .filter(name => name.endsWith('.proto'))
        .map(name => path.join(chosenProtoDir, name));
    await root.load(protoFiles, { keepCase: true });
    return {
        GateMessage: root.lookupType('gatepb.Message'),
        AllLandsReply: root.lookupType('gamepb.plantpb.AllLandsReply'),
        BagReply: root.lookupType('gamepb.itempb.BagReply'),
        VisitEnterReply: root.lookupType('gamepb.visitpb.EnterReply'),
        GetAllFriendsReply: root.lookupType('gamepb.friendpb.GetAllReply'),
        SyncAllReply: root.lookupType('gamepb.friendpb.SyncAllReply'),
        GetGameFriendsReply: root.lookupType('gamepb.friendpb.GetGameFriendsReply'),
    };
}

function decodeBag(reply, gameConfig) {
    const items = Array.isArray(reply && reply.item_bag && reply.item_bag.items) ? reply.item_bag.items : [];
    const rows = [];
    let totalCount = 0;
    let seedCount = 0;

    for (const item of items) {
        const itemId = toNum(item && item.id);
        const count = toNum(item && item.count);
        const config = gameConfig.getItemById(itemId);
        const name = config && config.name ? String(config.name).trim() : `item_${itemId}`;
        const price = toNum(config && config.price);
        const seedImage = gameConfig.getSeedImageBySeedId(itemId);
        const isSeed = !!seedImage || /seed/i.test(String(config && config.asset_name || ''));

        totalCount += count;
        if (isSeed) seedCount += count;

        rows.push({
            itemId,
            name,
            count,
            price,
            priceType: toNum(config && config.price_id),
            rarity: toNum(config && config.rarity),
            isSeed,
            seedImage,
            assetName: config && config.asset_name ? String(config.asset_name) : '',
            desc: config && config.desc ? String(config.desc) : '',
        });
    }

    rows.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.itemId - b.itemId;
    });

    return {
        summary: {
            totalKinds: rows.length,
            totalCount,
            seedKinds: rows.filter(item => item.isSeed).length,
            seedCount,
        },
        items: rows,
    };
}

function summarizeGameFriends(list) {
    const rows = (Array.isArray(list) ? list : []).map((friend) => ({
        gid: toNum(friend && friend.gid),
        name: String(friend && friend.name || '').trim(),
        remark: String(friend && friend.remark || '').trim(),
        level: toNum(friend && friend.level),
        gold: toNum(friend && friend.gold),
        avatarUrl: String(friend && friend.avatar_url || '').trim(),
        canSteal: toNum(friend && friend.plant && friend.plant.steal_plant_num),
        dryNum: toNum(friend && friend.plant && friend.plant.dry_num),
        weedNum: toNum(friend && friend.plant && friend.plant.weed_num),
        insectNum: toNum(friend && friend.plant && friend.plant.insect_num),
        ripeTimeSec: toNum(friend && friend.plant && friend.plant.ripe_time_sec),
        tags: {
            isNew: !!(friend && friend.tags && friend.tags.is_new),
            isFollow: !!(friend && friend.tags && friend.tags.is_follow),
        },
    }));

    rows.sort((a, b) => {
        if (b.canSteal !== a.canSteal) return b.canSteal - a.canSteal;
        if (a.ripeTimeSec !== b.ripeTimeSec) return a.ripeTimeSec - b.ripeTimeSec;
        return a.gid - b.gid;
    });

    return {
        summary: {
            total: rows.length,
            stealableFriends: rows.filter(item => item.canSteal > 0).length,
            needHelpFriends: rows.filter(item => item.dryNum > 0 || item.weedNum > 0 || item.insectNum > 0).length,
        },
        friends: rows,
    };
}

function decodeVisitEnter(reply, gameConfig) {
    const basic = reply && reply.basic ? reply.basic : {};
    const farm = decodeLands({ lands: Array.isArray(reply && reply.lands) ? reply.lands : [] }, gameConfig);
    return {
        friend: {
            gid: toNum(basic.gid),
            name: String(basic.name || '').trim(),
            level: toNum(basic.level),
            gold: toNum(basic.gold),
            avatarUrl: String(basic.avatar_url || '').trim(),
            remark: String(basic.remark || '').trim(),
        },
        ...farm,
    };
}

function getCurrentPhase(phases) {
    const list = Array.isArray(phases) ? phases : [];
    if (list.length === 0) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = list.length - 1; i >= 0; i--) {
        const phase = list[i];
        const beginTime = toTimeSec(phase && phase.begin_time);
        if (beginTime > 0 && beginTime <= nowSec) {
            return phase;
        }
    }
    return list[0] || null;
}

function getSlaveLandIds(land) {
    const ids = Array.isArray(land && land.slave_land_ids) ? land.slave_land_ids : [];
    return [...new Set(ids.map(id => toNum(id)).filter(Boolean))];
}

function buildLandMap(lands) {
    const map = new Map();
    for (const land of Array.isArray(lands) ? lands : []) {
        const id = toNum(land && land.id);
        if (id > 0) map.set(id, land);
    }
    return map;
}

function hasPlantData(land) {
    const plant = land && land.plant;
    return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

function getLinkedMasterLand(land, landsMap) {
    const landId = toNum(land && land.id);
    const masterLandId = toNum(land && land.master_land_id);
    if (!masterLandId || masterLandId === landId) return null;

    const masterLand = landsMap.get(masterLandId);
    if (!masterLand) return null;

    const slaveIds = getSlaveLandIds(masterLand);
    if (slaveIds.length > 0 && !slaveIds.includes(landId)) return null;

    return masterLand;
}

function getDisplayLandContext(land, landsMap) {
    const masterLand = getLinkedMasterLand(land, landsMap);
    if (masterLand && hasPlantData(masterLand)) {
        const occupiedLandIds = [toNum(masterLand.id), ...getSlaveLandIds(masterLand)].filter(Boolean);
        return {
            sourceLand: masterLand,
            occupiedByMaster: true,
            masterLandId: toNum(masterLand.id),
            occupiedLandIds,
        };
    }

    const selfId = toNum(land && land.id);
    return {
        sourceLand: land,
        occupiedByMaster: false,
        masterLandId: selfId,
        occupiedLandIds: [selfId].filter(Boolean),
    };
}

function summarizeLands(lands) {
    const summary = {
        total: 0,
        unlocked: 0,
        locked: 0,
        empty: 0,
        growing: 0,
        harvestable: 0,
        dead: 0,
        needWater: 0,
        needWeed: 0,
        needBug: 0,
    };

    for (const land of lands) {
        summary.total++;
        if (!land.unlocked) {
            summary.locked++;
            continue;
        }
        summary.unlocked++;
        if (land.status === 'empty') summary.empty++;
        if (land.status === 'growing') summary.growing++;
        if (land.status === 'harvestable') summary.harvestable++;
        if (land.status === 'dead') summary.dead++;
        if (land.needWater) summary.needWater++;
        if (land.needWeed) summary.needWeed++;
        if (land.needBug) summary.needBug++;
    }

    return summary;
}

function decodeLands(reply, gameConfig) {
    const rawLands = Array.isArray(reply && reply.lands) ? reply.lands : [];
    const landsMap = buildLandMap(rawLands);
    const nowSec = Math.floor(Date.now() / 1000);
    const lands = [];

    for (const land of rawLands) {
        const id = toNum(land.id);
        const level = toNum(land.level);
        const maxLevel = toNum(land.max_level);
        const landsLevel = toNum(land.lands_level);
        const landSize = toNum(land.land_size);
        const couldUnlock = !!land.could_unlock;
        const couldUpgrade = !!land.could_upgrade;
        const context = getDisplayLandContext(land, landsMap);
        const sourceLand = context.sourceLand;

        if (!land.unlocked) {
            lands.push({
                id,
                unlocked: false,
                status: 'locked',
                level,
                maxLevel,
                landsLevel,
                landSize,
                couldUnlock,
                couldUpgrade,
                phaseName: '',
                plantName: '',
                currentSeason: 0,
                totalSeason: 0,
                matureInSec: 0,
                matureInText: '',
                needWater: false,
                needWeed: false,
                needBug: false,
                occupiedByMaster: false,
                masterLandId: 0,
                occupiedLandIds: [],
                plantSize: 1,
                seedId: 0,
                seedImage: '',
                stealable: false,
                fruitNum: 0,
                leftFruitNum: 0,
                leftInorganicFertTimes: 0,
                baseFruitCount: 0,
                yieldBonus: 0,
                yieldBonusPercent: 0,
                estimatedYieldRatio: 0,
                mutantConfigIds: [],
                phaseMutants: [],
            });
            continue;
        }

        const plant = sourceLand && sourceLand.plant;
        if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
            lands.push({
                id,
                unlocked: true,
                status: 'empty',
                level,
                maxLevel,
                landsLevel,
                landSize,
                couldUnlock,
                couldUpgrade,
                phaseName: 'empty',
                plantName: '',
                currentSeason: 0,
                totalSeason: 0,
                matureInSec: 0,
                matureInText: '',
                needWater: false,
                needWeed: false,
                needBug: false,
                occupiedByMaster: context.occupiedByMaster,
                masterLandId: context.masterLandId,
                occupiedLandIds: context.occupiedLandIds,
                plantSize: 1,
                seedId: 0,
                seedImage: '',
                stealable: false,
                fruitNum: 0,
                leftFruitNum: 0,
                leftInorganicFertTimes: 0,
                baseFruitCount: 0,
                yieldBonus: 0,
                yieldBonusPercent: 0,
                estimatedYieldRatio: 0,
                mutantConfigIds: [],
                phaseMutants: [],
            });
            continue;
        }

        const currentPhase = getCurrentPhase(plant.phases);
        const phaseVal = toNum(currentPhase && currentPhase.phase);
        const plantId = toNum(plant.id);
        const plantCfg = gameConfig.getPlantById(plantId);
        const seedId = toNum(plantCfg && plantCfg.seed_id);
        const serverPlantName = String(plant.name || '').trim();
        const configPlantName = gameConfig.getPlantName(plantId);
        const plantName = configPlantName || serverPlantName || `plant_${plantId}`;
        const seedImage = seedId > 0 ? gameConfig.getSeedImageBySeedId(seedId) : '';
        const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
        const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
        const currentSeasonRaw = toNum(plant.season);
        const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
        const maturePhase = plant.phases.find(item => toNum(item && item.phase) === PLANT_PHASE.MATURE);
        const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
        const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;

        let status = 'growing';
        if (phaseVal === PLANT_PHASE.MATURE) status = 'harvestable';
        else if (phaseVal === PLANT_PHASE.DEAD) status = 'dead';
        else if (phaseVal === PLANT_PHASE.UNKNOWN) status = 'empty';

        const needWater = (toNum(plant.dry_num) > 0)
            || (toTimeSec(currentPhase && currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
        const needWeed = (Array.isArray(plant.weed_owners) && plant.weed_owners.length > 0)
            || (toTimeSec(currentPhase && currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
        const needBug = (Array.isArray(plant.insect_owners) && plant.insect_owners.length > 0)
            || (toTimeSec(currentPhase && currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);

        const baseFruitCount = Math.max(0, toNum(plantCfg && plantCfg.fruit && plantCfg.fruit.count) || 0);
        const fruitNum = toNum(plant.fruit_num);
        const leftFruitNum = toNum(plant.left_fruit_num);
        const yieldBonus = toNum(land.buff && land.buff.plant_yield_bonus);
        const yieldBonusPercent = yieldBonus ? Number((yieldBonus / 1000).toFixed(1)) : 0;
        const phaseMutants = [];
        for (const phase of Array.isArray(plant.phases) ? plant.phases : []) {
            for (const mutant of Array.isArray(phase && phase.mutants) ? phase.mutants : []) {
                phaseMutants.push({
                    mutantTime: toTimeSec(mutant && mutant.mutant_time),
                    mutantConfigId: toNum(mutant && mutant.mutant_config_id),
                    weatherId: toNum(mutant && mutant.weather_id),
                });
            }
        }
        const mutantConfigIds = [...new Set([
            ...((Array.isArray(plant.mutant_config_ids) ? plant.mutant_config_ids : []).map(v => toNum(v)).filter(Boolean)),
            ...phaseMutants.map(item => item.mutantConfigId).filter(Boolean),
        ])];
        const estimatedYieldRatio = baseFruitCount > 0 && fruitNum > 0
            ? Number((fruitNum / baseFruitCount).toFixed(2))
            : 0;

        lands.push({
            id,
            unlocked: true,
            status,
            level,
            maxLevel,
            landsLevel,
            landSize,
            couldUnlock,
            couldUpgrade,
            phaseName: PHASE_NAMES[phaseVal] || `phase_${phaseVal}`,
            plantName,
            currentSeason,
            totalSeason,
            matureInSec,
            matureInText: matureInSec > 0 ? formatTime(matureInSec) : '',
            needWater,
            needWeed,
            needBug,
            occupiedByMaster: context.occupiedByMaster,
            masterLandId: context.masterLandId,
            occupiedLandIds: context.occupiedLandIds,
            plantSize,
            seedId,
            seedImage,
            stealable: !!plant.stealable,
            fruitNum,
            leftFruitNum,
            leftInorganicFertTimes: toNum(plant.left_inorc_fert_times),
            baseFruitCount,
            yieldBonus,
            yieldBonusPercent,
            estimatedYieldRatio,
            mutantConfigIds,
            phaseMutants,
        });
    }

    return {
        summary: summarizeLands(lands),
        lands,
    };
}

function buildCnFieldMap() {
    return {
        meta: {
            service_name: '服务名',
            method_name: '方法名',
            message_type: '消息类型',
            client_seq: '客户端序号',
            server_seq: '服务端序号',
            error_code: '错误码',
            error_message: '错误信息',
            metadata: '附加元数据',
        },
        summary: {
            total: '土地总数',
            unlocked: '已解锁土地数',
            locked: '未解锁土地数',
            empty: '空地数',
            growing: '生长中土地数',
            harvestable: '可收获土地数',
            dead: '枯萎土地数',
            needWater: '缺水土地数',
            needWeed: '长草土地数',
            needBug: '生虫土地数',
        },
        land: {
            id: '土地ID',
            unlocked: '是否已解锁',
            status: '土地状态',
            level: '土地等级',
            maxLevel: '土地最高等级',
            landsLevel: '地块等级',
            landSize: '土地尺寸',
            couldUnlock: '是否可解锁',
            couldUpgrade: '是否可升级',
            phaseName: '当前阶段',
            plantName: '作物名称',
            currentSeason: '当前季数',
            totalSeason: '总季数',
            matureInSec: '距离成熟秒数',
            matureInText: '距离成熟文本',
            needWater: '是否缺水',
            needWeed: '是否长草',
            needBug: '是否生虫',
            occupiedByMaster: '是否被主地块占用',
            masterLandId: '主地块ID',
            occupiedLandIds: '占用地块ID列表',
            plantSize: '作物占地尺寸',
            seedId: '种子ID',
            seedImage: '种子图片路径',
            stealable: '是否可偷',
            fruitNum: '当前果实数',
            leftFruitNum: '剩余果实数',
            leftInorganicFertTimes: '剩余施肥次数',
            baseFruitCount: '基础果实数',
            yieldBonus: '土地产量加成原始值',
            yieldBonusPercent: '土地产量加成百分比',
            estimatedYieldRatio: '估算倍率',
            mutantConfigIds: '变异配置ID列表',
            phaseMutants: '阶段变异事件',
        },
        rawBody: {
            lands: '原始土地数组',
            operation_limits: '操作限制数组',
        },
        rawLand: {
            id: '土地ID',
            unlocked: '是否已解锁',
            level: '土地等级',
            max_level: '土地最高等级',
            could_unlock: '是否可解锁',
            could_upgrade: '是否可升级',
            upgrade_condition: '升级条件',
            buff: '土地加成',
            plant: '作物信息',
            is_shared: '是否共享地块',
            can_share: '是否可共享',
            master_land_id: '主地块ID',
            slave_land_ids: '从地块ID列表',
            land_size: '土地尺寸',
            lands_level: '地块等级',
        },
        plant: {
            id: '作物ID',
            name: '作物名',
            phases: '生长阶段列表',
            season: '季数',
            dry_num: '缺水次数',
            stole_num: '被偷次数',
            fruit_id: '果实ID',
            fruit_num: '果实数量',
            weed_owners: '长草来源',
            insect_owners: '生虫来源',
            stealers: '偷取者列表',
            grow_sec: '总生长秒数',
            stealable: '是否可偷',
            left_inorc_fert_times: '剩余施肥次数',
            left_fruit_num: '剩余果实数',
            steal_intimacy_level: '亲密度要求',
            mutant_config_ids: '变异配置ID列表',
            is_nudged: '是否被催熟',
        },
        phase: {
            phase: '阶段值',
            begin_time: '阶段开始时间',
            phase_id: '阶段ID',
            dry_time: '缺水时间',
            weeds_time: '长草时间',
            insect_time: '生虫时间',
            ferts_used: '已使用肥料',
            mutants: '变异信息',
        },
        operationLimit: {
            id: '操作ID',
            day_times: '今日操作次数',
            day_times_lt: '每日操作上限',
            day_share_id: '分享ID',
            day_exp_times: '今日经验次数',
            day_ex_times_lt: '每日经验上限',
            day_exp_share_id: '经验分享ID',
        },
    };
}

function annotateValue(value, labelMap, childConfig = {}) {
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (item && typeof item === 'object' && childConfig.arrayItemMap) {
                return annotateObject(item, childConfig.arrayItemMap, childConfig.arrayItemChildConfig || {});
            }
            return item;
        });
    }

    if (value && typeof value === 'object') {
        const childMap = childConfig.objectMap || labelMap;
        return annotateObject(value, childMap, childConfig.objectChildConfig || {});
    }

    return value;
}

function annotateObject(obj, labelMap, childConfigByKey = {}) {
    const out = {};
    for (const [key, value] of Object.entries(obj || {})) {
        const item = {
            含义: labelMap[key] || key,
            值: annotateValue(value, labelMap, childConfigByKey[key] || {}),
        };

        if (key === 'status') {
            item.说明 = STATUS_LABELS_ZH[String(value) || ''] || '';
        } else if (key === 'phaseName') {
            item.说明 = PHASE_LABELS_ZH[String(value) || ''] || '';
        } else if (key === 'message_type') {
            const mt = Number(value || 0);
            item.说明 = mt === 1 ? '请求' : (mt === 2 ? '响应' : (mt === 3 ? '通知' : '未知'));
        } else if (key === 'phase') {
            const code = Number(value || 0);
            item.说明 = PHASE_LABELS_ZH[PHASE_NAMES[code] || ''] || '';
        }

        out[key] = item;
    }
    return out;
}

function buildCnJson(gateJson, replyJson, result) {
    const labels = buildCnFieldMap();
    return {
        说明: 'QQ农场 AllLands 土地信息返回，已附带中文字段解释',
        meta: annotateObject(gateJson.meta || {}, labels.meta),
        summary: annotateObject(result.summary, labels.summary),
        lands: (result.lands || []).map(land => annotateObject(land, labels.land)),
        raw_body: annotateObject(replyJson || {}, labels.rawBody, {
            lands: {
                arrayItemMap: labels.rawLand,
                arrayItemChildConfig: {
                    plant: {
                        objectMap: labels.plant,
                        objectChildConfig: {
                            phases: {
                                arrayItemMap: labels.phase,
                            },
                        },
                    },
                },
            },
            operation_limits: {
                arrayItemMap: labels.operationLimit,
            },
        }),
    };
}

function renderBadge(text, tone = 'neutral') {
    return `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;
}

function renderKv(label, value) {
    return `<div class="kv"><span class="kv-label">${escapeHtml(label)}</span><span class="kv-value">${value}</span></div>`;
}

function getStatusTone(status) {
    if (status === 'harvestable') return 'good';
    if (status === 'dead') return 'danger';
    if (status === 'growing') return 'info';
    if (status === 'empty') return 'muted';
    if (status === 'locked') return 'muted';
    return 'neutral';
}

function getMutantTypeLabels(land) {
    const labels = [];
    const plantName = String(land && land.plantName || '').trim();

    if (!plantName) return labels;
    if (plantName.startsWith('黄金·') || plantName.startsWith('黄金果')) labels.push('黄金');
    if (plantName.includes('爱心')) labels.push('爱心');
    if (plantName.startsWith('变异') || plantName.includes('变异')) labels.push('变异');

    return [...new Set(labels)];
}

function buildLandHtml(land, rawLand, outputFile) {
    const statusLabel = STATUS_LABELS_ZH[land.status] || land.status;
    const phaseLabel = PHASE_LABELS_ZH[land.phaseName] || land.phaseName || '-';
    const imgPath = land.seedImage ? getRelativeAssetPath(outputFile, land.seedImage) : '';
    const tags = [];
    const hasMutants = Array.isArray(land.mutantConfigIds) && land.mutantConfigIds.length > 0;
    const mutantTypeLabels = getMutantTypeLabels(land);
    if (land.needWater) tags.push(renderBadge('缺水', 'info'));
    if (land.needWeed) tags.push(renderBadge('长草', 'warn'));
    if (land.needBug) tags.push(renderBadge('生虫', 'danger'));
    if (land.couldUpgrade) tags.push(renderBadge('可升级', 'good'));
    if (land.couldUnlock) tags.push(renderBadge('可解锁', 'good'));
    if (land.stealable) tags.push(renderBadge('可偷', 'accent'));
    if (hasMutants) {
        tags.push(renderBadge(`已变异 ${land.plantName || ''}`.trim(), 'accent'));
        for (const label of mutantTypeLabels) {
            tags.push(renderBadge(`${label}变异`, 'accent'));
        }
    }

    const phaseMutantsHtml = Array.isArray(land.phaseMutants) && land.phaseMutants.length > 0
        ? land.phaseMutants.map(item => `${escapeHtml(item.mutantConfigId || '-')}&nbsp;@&nbsp;${escapeHtml(item.mutantTime ? formatDateTimeFromSec(item.mutantTime) : '-')}`).join('<br>')
        : '-';
    const mutantSummaryHtml = hasMutants
        ? `
        <div class="kv-grid" style="margin-bottom: 10px;">
          ${renderKv('当前变异状态', '<span style="color:#805ad5;font-weight:800;">已变异</span>')}
          ${renderKv('变异结果', escapeHtml(land.plantName || '-'))}
          ${renderKv('变异类型', escapeHtml(mutantTypeLabels.length ? mutantTypeLabels.join(' / ') : '已变异（类型待确认）'))}
          ${renderKv('变异数量', escapeHtml(land.mutantConfigIds.length))}
          ${renderKv('协议变异ID', escapeHtml(land.mutantConfigIds.join(', ')))}
          ${renderKv('变异时间线', phaseMutantsHtml)}
        </div>`
        : `
        <div class="kv-grid" style="margin-bottom: 10px;">
          ${renderKv('当前变异状态', '<span style="color:#7a6a55;font-weight:700;">无变异</span>')}
          ${renderKv('变异结果', '-')}
        </div>`;

    const rawJson = JSON.stringify(rawLand || {}, null, 2);

    return `
      <article class="card">
        <div class="card-head">
          <div>
            <div class="card-title">#${escapeHtml(land.id)} ${escapeHtml(land.plantName || '空地')}</div>
            <div class="card-subtitle">${renderBadge(statusLabel, getStatusTone(land.status))} ${renderBadge(`阶段: ${phaseLabel}`, 'neutral')}</div>
          </div>
          ${imgPath ? `<img class="seed-image" src="${escapeHtml(imgPath)}" alt="${escapeHtml(land.plantName || 'seed')}" />` : '<div class="seed-image seed-image-empty">No Image</div>'}
        </div>
        <div class="badge-row">${tags.join(' ')}</div>
        ${mutantSummaryHtml}
        <div class="kv-grid">
          ${renderKv('土地等级', escapeHtml(`${land.level}/${land.maxLevel || '-'}`))}
          ${renderKv('地块等级', escapeHtml(land.landsLevel))}
          ${renderKv('季数', escapeHtml(`${land.currentSeason}/${land.totalSeason}`))}
          ${renderKv('成熟倒计时', escapeHtml(land.matureInText || '-'))}
          ${renderKv('成熟时间', escapeHtml(land.matureInSec > 0 ? formatDateTimeFromSec(Math.floor(Date.now() / 1000) + land.matureInSec) : '-'))}
          ${renderKv('土地尺寸', escapeHtml(land.landSize || 0))}
          ${renderKv('占地尺寸', escapeHtml(`${land.plantSize}x${land.plantSize}`))}
          ${renderKv('种子ID', escapeHtml(land.seedId || '-'))}
          ${renderKv('当前果实数', escapeHtml(land.fruitNum || 0))}
          ${renderKv('基础果实数', escapeHtml(land.baseFruitCount || 0))}
          ${renderKv('估算倍率', escapeHtml(land.estimatedYieldRatio ? `${land.estimatedYieldRatio}x` : '-'))}
          ${renderKv('土地产量加成', escapeHtml(land.yieldBonusPercent ? `${land.yieldBonusPercent}%` : '-'))}
          ${renderKv('剩余果实', escapeHtml(land.leftFruitNum || 0))}
          ${renderKv('剩余施肥次数', escapeHtml(land.leftInorganicFertTimes || 0))}
          ${renderKv('主地块ID', escapeHtml(land.masterLandId || '-'))}
          ${renderKv('占用地块', escapeHtml(Array.isArray(land.occupiedLandIds) && land.occupiedLandIds.length ? land.occupiedLandIds.join(', ') : '-'))}
        </div>
        <details class="raw-panel">
          <summary>查看原始 JSON</summary>
          <pre>${escapeHtml(rawJson)}</pre>
        </details>
      </article>
    `;
}

function buildHtmlDocument(service, method, gateJson, replyJson, result, inputFile, outputFile) {
    const rawLandMap = new Map((replyJson.lands || []).map(item => [String(item.id), item]));
    const landCards = result.lands.map(land => buildLandHtml(land, rawLandMap.get(String(land.id)), outputFile)).join('\n');
    const meta = gateJson.meta || {};
    const traceId = meta.metadata && meta.metadata['x-traceid'] ? meta.metadata['x-traceid'] : '';

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QQ 农场土地信息</title>
  <style>
    :root {
      --bg: #f3efe6;
      --panel: #fffaf1;
      --card: #ffffff;
      --line: #e5d8bf;
      --text: #2f261c;
      --muted: #7a6a55;
      --good: #2f855a;
      --warn: #b7791f;
      --danger: #c53030;
      --info: #2b6cb0;
      --accent: #805ad5;
      --shadow: 0 12px 24px rgba(80, 58, 30, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.8), transparent 30%),
        linear-gradient(180deg, #efe7d5 0%, var(--bg) 100%);
      color: var(--text);
    }
    .wrap {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      background: linear-gradient(135deg, #fff8e8 0%, #f6ead2 100%);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 24px;
      box-shadow: var(--shadow);
      margin-bottom: 20px;
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 32px;
      line-height: 1.1;
    }
    .hero p {
      margin: 4px 0;
      color: var(--muted);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin: 20px 0;
    }
    .summary-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .summary-card .num {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .summary-card .label {
      color: var(--muted);
      font-size: 14px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }
    .card-title {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .card-subtitle {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
      min-height: 24px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 700;
      background: #f1eadc;
      color: var(--text);
      border: 1px solid rgba(0,0,0,0.06);
    }
    .badge-good { background: #e6ffef; color: var(--good); }
    .badge-warn { background: #fff5df; color: var(--warn); }
    .badge-danger { background: #fff0f0; color: var(--danger); }
    .badge-info { background: #eaf4ff; color: var(--info); }
    .badge-accent { background: #f3edff; color: var(--accent); }
    .badge-muted { background: #f3efe9; color: var(--muted); }
    .badge-neutral { background: #f5f1e8; color: var(--text); }
    .kv-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .kv {
      background: var(--panel);
      border: 1px solid #efe1c3;
      border-radius: 12px;
      padding: 10px 12px;
    }
    .kv-label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .kv-value {
      font-weight: 700;
      word-break: break-word;
      line-height: 1.5;
    }
    .seed-image {
      width: 72px;
      height: 72px;
      object-fit: contain;
      border-radius: 16px;
      background: #fff;
      border: 1px solid var(--line);
      padding: 6px;
      flex: 0 0 auto;
    }
    .seed-image-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 12px;
    }
    .raw-panel {
      margin-top: 14px;
      border-top: 1px dashed var(--line);
      padding-top: 12px;
    }
    .raw-panel summary {
      cursor: pointer;
      font-weight: 700;
    }
    .raw-panel pre {
      margin: 10px 0 0;
      padding: 12px;
      border-radius: 12px;
      background: #231d17;
      color: #f8f0e3;
      overflow: auto;
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 720px) {
      .wrap { padding: 14px; }
      .hero h1 { font-size: 26px; }
      .kv-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>QQ 农场土地信息</h1>
      <p>来源文件：${escapeHtml(inputFile)}</p>
      <p>消息：${escapeHtml(service)} / ${escapeHtml(method)}</p>
      <p>客户端序号：${escapeHtml(meta.client_seq || '')}，服务端序号：${escapeHtml(meta.server_seq || '')}</p>
      <p>TraceId：${escapeHtml(traceId || '-')}</p>
      <p>生成时间：${escapeHtml(new Date().toLocaleString('zh-CN', { hour12: false }))}</p>
    </section>
    <section class="summary-grid">
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.total)}</div><div class="label">土地总数</div></div>
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.unlocked)}</div><div class="label">已解锁</div></div>
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.growing)}</div><div class="label">生长中</div></div>
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.harvestable)}</div><div class="label">可收获</div></div>
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.needWater)}</div><div class="label">缺水</div></div>
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.needWeed)}</div><div class="label">长草</div></div>
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.needBug)}</div><div class="label">生虫</div></div>
      <div class="summary-card"><div class="num">${escapeHtml(result.summary.dead)}</div><div class="label">枯萎</div></div>
    </section>
    <section class="cards">
      ${landCards}
    </section>
  </div>
</body>
</html>`;
}

function printText(result, service, method) {
    process.stdout.write(`Message: ${service}.${method}\n`);
    process.stdout.write(`Lands: ${result.lands.length}\n\n`);
    process.stdout.write(`Summary: ${JSON.stringify(result.summary, null, 2)}\n\n`);
    for (const land of result.lands) {
        process.stdout.write(JSON.stringify(land) + '\n');
    }
}

async function main() {
    const options = parseArgs();
    if (!fs.existsSync(options.input)) {
        process.stderr.write(`File not found: ${options.input}\n`);
        process.exit(1);
    }

    const proto = await loadProto();
    const gameConfig = loadGameConfig();
    const buffer = fs.readFileSync(options.input);
    const gate = proto.GateMessage.decode(buffer);
    const gateJson = gate.toJSON ? gate.toJSON() : gate;
    const meta = gate.meta || {};
    const service = String(meta.service_name || '');
    const method = String(meta.method_name || '');

    if (service !== 'gamepb.plantpb.PlantService' || method !== 'AllLands') {
        process.stderr.write(`Unexpected message: ${service}.${method}\n`);
        process.exit(1);
    }

    const reply = proto.AllLandsReply.decode(gate.body);
    const replyJson = reply.toJSON ? reply.toJSON() : reply;
    const result = decodeLands(reply, gameConfig);

    if (options.rawJson) {
        process.stdout.write(`${JSON.stringify({ meta: gateJson.meta || {}, body: replyJson }, null, 2)}\n`);
        return;
    }

    if (options.prettyJson) {
        process.stdout.write(`${JSON.stringify({
            message: `${service}.${method}`,
            summary: result.summary,
            lands: result.lands,
        }, null, 2)}\n`);
        return;
    }

    if (options.cnJson) {
        process.stdout.write(`${JSON.stringify(buildCnJson(gateJson, replyJson, result), null, 2)}\n`);
        return;
    }

    if (options.html) {
        const outputFile = options.out || getDefaultHtmlOutputPath(options.input);
        ensureDirForFile(outputFile);
        const html = buildHtmlDocument(service, method, gateJson, replyJson, result, options.input, outputFile);
        fs.writeFileSync(outputFile, html, 'utf8');
        process.stdout.write(`HTML written to: ${outputFile}\n`);
        return;
    }

    printText(result, service, method);
}

module.exports = {
    loadProto,
    loadGameConfig,
    decodeLands,
    decodeBag,
    summarizeGameFriends,
    decodeVisitEnter,
    buildCnJson,
};

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
        process.exit(1);
    });
}
