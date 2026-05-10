#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Resvg } = require('@resvg/resvg-js');
const {
    readPidInfo,
    isPidAlive,
} = require('./process-manager');
const {
    loadProto,
    loadGameConfig,
    decodeLands,
    decodeBag,
    summarizeGameFriends,
    decodeVisitEnter,
    buildCnJson,
} = require('./index');

const DEFAULT_PORT = Number(process.env.REQABLE_LOG_PORT || 18088);
const DEFAULT_LOG_DIR = path.resolve(process.cwd(), 'logs');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TARGET_WS_URL = 'wss://gate-obt.nqf.qq.com/prod/ws';
const TARGET_WS_HOST = 'gate-obt.nqf.qq.com';
const TARGET_WS_PATH = '/prod/ws';
const DECODER_TARGETS = {
    'gamepb.plantpb.PlantService.AllLands': 'allLands',
    'gamepb.itempb.ItemService.Bag': 'bag',
    'gamepb.visitpb.VisitService.Enter': 'visitEnter',
    'gamepb.friendpb.FriendService.GetAll': 'friendList',
    'gamepb.friendpb.FriendService.SyncAll': 'friendList',
    'gamepb.friendpb.FriendService.GetGameFriends': 'friendList',
};

const runtimeState = {
    updatedAt: '',
    lastFrame: null,
    farm: null,
    bag: null,
    friendList: null,
    currentVisit: null,
    history: [],
};

let runtime = null;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function nowForFile(date = new Date()) {
    const y = date.getFullYear();
    const m = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    return `${y}${m}${d}`;
}

function nowForLine(date = new Date()) {
    const y = date.getFullYear();
    const m = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    const hh = pad2(date.getHours());
    const mm = pad2(date.getMinutes());
    const ss = pad2(date.getSeconds());
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function nowForStamp(date = new Date()) {
    const y = date.getFullYear();
    const m = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    const hh = pad2(date.getHours());
    const mm = pad2(date.getMinutes());
    const ss = pad2(date.getSeconds());
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${y}${m}${d}-${hh}${mm}${ss}-${ms}`;
}

function getFramesDateDir(date = new Date()) {
    return path.join(DEFAULT_LOG_DIR, 'frames', nowForFile(date));
}

function getLatestAllLandsCnJsonFile() {
    const dir = getFramesDateDir();
    if (!fs.existsSync(dir)) return '';
    const files = fs.readdirSync(dir)
        .filter(name => name.endsWith('.server_to_client.gamepb.plantpb.PlantService.AllLands.cn.json'))
        .sort()
        .reverse();
    if (files.length === 0) return '';
    return path.join(dir, files[0]);
}

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ error: 'json-stringify-failed' });
    }
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toPublicAssetUrl(assetPath) {
    const normalized = String(assetPath || '').trim().replace(/\\/g, '/');
    if (!normalized) return '';
    if (normalized.startsWith('./game-config/')) {
        return `/${normalized.slice(2)}`;
    }
    if (normalized.startsWith('game-config/')) {
        return `/${normalized}`;
    }
    return normalized;
}

function toAbsoluteAssetPath(assetPath) {
    const normalized = String(assetPath || '').trim().replace(/\\/g, '/');
    if (!normalized) return '';
    if (normalized.startsWith('./')) {
        return path.join(PROJECT_ROOT, normalized.slice(2));
    }
    if (normalized.startsWith('/')) {
        return normalized;
    }
    return path.join(PROJECT_ROOT, normalized);
}

function getImageMimeType(file) {
    const ext = path.extname(String(file || '')).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'application/octet-stream';
}

function getInlineImageDataUri(assetPath) {
    const abs = toAbsoluteAssetPath(assetPath);
    if (!abs || !fs.existsSync(abs)) return '';
    const mime = getImageMimeType(abs);
    const base64 = fs.readFileSync(abs).toString('base64');
    return `data:${mime};base64,${base64}`;
}

function cloneState() {
    return JSON.parse(JSON.stringify(runtimeState));
}

function getUiRuntimeStatus() {
    const pidInfo = readPidInfo();
    const proxyRunning = !!(pidInfo && pidInfo.mitmPid && isPidAlive(pidInfo.mitmPid));
    const serverRunning = true;
    const lastCaptureAt = runtimeState.updatedAt || '';
    const hasFriendData = !!(
        runtimeState.currentVisit
        && runtimeState.currentVisit.friend
        && (runtimeState.currentVisit.friend.name || runtimeState.currentVisit.friend.remark || runtimeState.currentVisit.friend.gid)
    );

    return {
        proxyRunning,
        serverRunning,
        lastCaptureAt,
        hasFriendData,
    };
}

function decodeBodyToString(body) {
    if (body === null || body === undefined) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body.toString('utf8');
    if (Array.isArray(body)) return Buffer.from(body).toString('utf8');
    if (typeof body === 'object') {
        if (body.type === 'Buffer' && Array.isArray(body.data)) {
            return Buffer.from(body.data).toString('utf8');
        }
        if (typeof body.base64 === 'string') {
            return Buffer.from(body.base64, 'base64').toString('utf8');
        }
    }
    return String(body);
}

function decodeBodyToBase64(body) {
    if (body === null || body === undefined) return '';
    if (typeof body === 'string') return Buffer.from(body, 'utf8').toString('base64');
    if (Buffer.isBuffer(body)) return body.toString('base64');
    if (Array.isArray(body)) return Buffer.from(body).toString('base64');
    if (typeof body === 'object') {
        if (body.type === 'Buffer' && Array.isArray(body.data)) {
            return Buffer.from(body.data).toString('base64');
        }
        if (typeof body.base64 === 'string') {
            return body.base64;
        }
    }
    return Buffer.from(String(body), 'utf8').toString('base64');
}

function isTargetWsUrl(urlValue) {
    const value = String(urlValue || '').trim();
    if (!value) return false;

    try {
        const parsed = new URL(value);
        return parsed.hostname === TARGET_WS_HOST && parsed.pathname === TARGET_WS_PATH;
    } catch {
        return value.includes(TARGET_WS_HOST) && value.includes(TARGET_WS_PATH);
    }
}

function buildLogEntry(payload, remoteIp) {
    const ts = nowForLine();
    const record = payload && typeof payload === 'object' ? payload : {};
    const url = String(record.url || record.websocketUrl || record.requestUrl || '');
    const direction = String(record.direction || record.wsDirection || record.from || '').toLowerCase();
    const messageType = String(record.messageType || record.type || record.frameType || '').toLowerCase();
    const body = record.body ?? record.message ?? record.data ?? '';
    const text = decodeBodyToString(body);
    const base64 = decodeBodyToBase64(body);

    return {
        ts,
        remoteIp,
        source: 'reqable',
        url,
        matched: isTargetWsUrl(url),
        direction,
        messageType,
        text,
        base64,
        raw: record,
    };
}

function appendJsonLine(dir, name, obj) {
    ensureDir(dir);
    const file = path.join(dir, `${name}.${nowForFile()}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
    return file;
}

function sanitizeSegment(value, fallback) {
    const cleaned = String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || fallback;
}

function decodeBase64ToBuffer(base64) {
    if (!base64 || typeof base64 !== 'string') return Buffer.alloc(0);
    return Buffer.from(base64, 'base64');
}

function getMessageTypeFlags(messageType, opcode) {
    const normalized = String(messageType || '').toLowerCase();
    const op = Number(opcode);
    const isBinary = normalized === 'binary' || op === 2;
    const isText = normalized === 'text' || op === 1;
    return { isBinary, isText };
}

function buildMitmEntry(payload, remoteIp) {
    const record = payload && typeof payload === 'object' ? payload : {};
    const url = String(record.url || '');
    const messageType = String(record.messageType || '').toLowerCase();
    const direction = String(record.direction || '').toLowerCase();
    const opcode = Number(record.opcode);
    const base64 = String(record.base64 || '');
    const text = typeof record.text === 'string' ? record.text : '';

    return {
        ts: nowForLine(),
        remoteIp,
        source: 'mitmproxy',
        url,
        matched: isTargetWsUrl(url),
        direction,
        messageType,
        opcode: Number.isFinite(opcode) ? opcode : 0,
        text,
        base64,
        raw: record,
    };
}

function ensureRuntime() {
    if (runtime) return runtime;
    runtime = (async () => {
        const proto = await loadProto();
        const gameConfig = loadGameConfig();
        return { proto, gameConfig };
    })();
    return runtime;
}

async function tryDecodeGateMessage(buffer) {
    if (!buffer || buffer.length === 0) {
        return { ok: false, error: 'empty-buffer' };
    }

    const { proto, gameConfig } = await ensureRuntime();

    let gate;
    try {
        gate = proto.GateMessage.decode(buffer);
    } catch (error) {
        return {
            ok: false,
            error: `gate-decode-failed: ${error && error.message ? error.message : String(error)}`,
        };
    }

    const gateJson = gate.toJSON ? gate.toJSON() : gate;
    const meta = gate && gate.meta ? gate.meta : {};
    const service = String(meta.service_name || '');
    const method = String(meta.method_name || '');

    const key = `${service}.${method}`;
    const targetKind = DECODER_TARGETS[key] || '';
    const decoded = {
        ok: true,
        gateJson,
        service,
        method,
        decoderKey: key,
        targetKind,
        isTarget: !!targetKind,
        summary: null,
        cnJson: null,
        payload: null,
    };

    if (!decoded.isTarget) {
        return decoded;
    }

    try {
        if (targetKind === 'allLands') {
            const reply = proto.AllLandsReply.decode(gate.body);
            const replyJson = reply.toJSON ? reply.toJSON() : reply;
            const result = decodeLands(reply, gameConfig);
            decoded.summary = result.summary;
            decoded.cnJson = buildCnJson(gateJson, replyJson, result);
            decoded.payload = {
                type: 'allLands',
                data: result,
            };
        } else if (targetKind === 'bag') {
            const reply = proto.BagReply.decode(gate.body);
            const replyJson = reply.toJSON ? reply.toJSON() : reply;
            const result = decodeBag(reply, gameConfig);
            decoded.summary = result.summary;
            decoded.payload = {
                type: 'bag',
                data: result,
                rawBody: replyJson,
            };
        } else if (targetKind === 'visitEnter') {
            const reply = proto.VisitEnterReply.decode(gate.body);
            const replyJson = reply.toJSON ? reply.toJSON() : reply;
            const result = decodeVisitEnter(reply, gameConfig);
            decoded.summary = {
                friend: result.friend,
                farm: result.summary,
            };
            decoded.payload = {
                type: 'visitEnter',
                data: result,
                rawBody: replyJson,
            };
        } else if (targetKind === 'friendList') {
            const replyType = method === 'GetAll'
                ? proto.GetAllFriendsReply
                : (method === 'GetGameFriends' ? proto.GetGameFriendsReply : proto.SyncAllReply);
            const reply = replyType.decode(gate.body);
            const replyJson = reply.toJSON ? reply.toJSON() : reply;
            const result = summarizeGameFriends(reply && reply.game_friends);
            decoded.summary = result.summary;
            decoded.payload = {
                type: 'friendList',
                data: result,
                rawBody: replyJson,
            };
        }
        return decoded;
    } catch (error) {
        decoded.ok = false;
        decoded.error = `decode-failed: ${error && error.message ? error.message : String(error)}`;
        return decoded;
    }
}

function updateRuntimeState(entry, decoded) {
    if (!decoded || !decoded.isTarget || !decoded.payload || !decoded.ok) return;

    runtimeState.updatedAt = entry.ts;
    runtimeState.lastFrame = {
        ts: entry.ts,
        service: decoded.service,
        method: decoded.method,
        direction: entry.direction,
        source: entry.source,
    };

    if (decoded.payload.type === 'allLands') {
        runtimeState.farm = {
            ts: entry.ts,
            service: decoded.service,
            method: decoded.method,
            ...decoded.payload.data,
        };
    }

    if (decoded.payload.type === 'bag') {
        runtimeState.bag = {
            ts: entry.ts,
            service: decoded.service,
            method: decoded.method,
            ...decoded.payload.data,
        };
    }

    if (decoded.payload.type === 'friendList') {
        runtimeState.friendList = {
            ts: entry.ts,
            service: decoded.service,
            method: decoded.method,
            ...decoded.payload.data,
        };
    }

    if (decoded.payload.type === 'visitEnter') {
        runtimeState.currentVisit = {
            ts: entry.ts,
            service: decoded.service,
            method: decoded.method,
            ...decoded.payload.data,
        };
    }

    runtimeState.history.unshift({
        ts: entry.ts,
        service: decoded.service,
        method: decoded.method,
        targetKind: decoded.targetKind,
        summary: decoded.summary || null,
    });
    runtimeState.history = runtimeState.history.slice(0, 50);
}

function renderMonitorPage(state) {
    const s = state || {};
    const farm = s.farm || {};
    const friendList = s.friendList || {};
    const visit = s.currentVisit || {};
    const history = Array.isArray(s.history) ? s.history : [];
    const runtimeStatus = getUiRuntimeStatus();

    const farmLands = Array.isArray(farm.lands) ? farm.lands.slice(0, 24) : [];
    const friends = Array.isArray(friendList.friends) ? friendList.friends : [];
    const visitLands = Array.isArray(visit.lands) ? visit.lands : [];

    const renderJson = (value) => safeJson(value).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    const renderSummaryCard = (label, value, tone = '') => `<div class="stat ${tone}"><div class="stat-value">${value ?? '-'}</div><div class="stat-label">${label}</div></div>`;
    const renderRuntimePill = (label, value, ok) => `<div class="runtime-pill ${ok ? 'runtime-pill-ok' : 'runtime-pill-off'}"><span>${label}</span><strong>${value}</strong></div>`;
    const statusLabelMap = {
        locked: '未解锁',
        empty: '空地',
        growing: '生长中',
        harvestable: '可收获',
        dead: '枯萎',
    };
    const phaseLabelMap = {
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
    const mutantLabelByConfigId = {
        1: '冰冻',
        2: '冰冻',
        3: '暗化',
        4: '湿润',
        5: '黄金',
        6: '稀世',
        1040046: '爱心',
        1040025: '冰冻',
        1040109: '火焰',
        1040112: '黄金',
        1040121: '黄金',
        1040224: '幽灵',
        1040249: '稀世',
    };
    const isNameMatchedForMutant = (plantName, label) => {
        const name = String(plantName || '').trim();
        if (!name) return false;
        if (label === '爱心') return name.includes('爱心·') || name.includes('·爱心');
        if (label === '黄金') return name.includes('黄金·') || name.includes('·黄金');
        if (label === '冰冻') return name.includes('冰冻');
        if (label === '火焰') return name.includes('火焰');
        if (label === '幽灵') return name.includes('幽灵');
        if (label === '稀世') return name.includes('稀世');
        return false;
    };
    const getMutantTypeLabels = (land) => {
        const labels = [];
        const plantName = String(land && land.plantName || '').trim();
        const mutantIds = Array.isArray(land && land.mutantConfigIds) ? land.mutantConfigIds : [];

        for (const id of mutantIds) {
            const label = mutantLabelByConfigId[Number(id) || 0];
            if (label) labels.push(label);
        }

        const hasExplicitMutant = mutantIds.length > 0;
        if (!hasExplicitMutant) {
            if (plantName.startsWith('变异')) labels.push('普通变异');
            if (plantName.includes('爱心·') || plantName.includes('·爱心')) labels.push('爱心');
            if (plantName.includes('黄金·') || plantName.includes('·黄金')) labels.push('黄金');
            if (plantName.includes('冰冻')) labels.push('冰冻');
            if (plantName.includes('火焰')) labels.push('火焰');
            if (plantName.includes('幽灵')) labels.push('幽灵');
            if (plantName.includes('稀世')) labels.push('稀世');
        }

        if (hasExplicitMutant && labels.length === 0) {
            labels.push(`未知变异(${mutantIds.join(',')})`);
        }

        return [...new Set(labels)];
    };
    const renderCareBadges = (land) => {
        const tags = [];
        if (land.needWater) tags.push('<span class="tag tag-water">缺水</span>');
        if (land.needWeed) tags.push('<span class="tag tag-weed">长草</span>');
        if (land.needBug) tags.push('<span class="tag tag-bug">生虫</span>');
        if (land.stealable) tags.push('<span class="tag tag-steal">可偷</span>');
        if (land.couldUpgrade) tags.push('<span class="tag tag-good">可升级</span>');
        if (land.couldUnlock) tags.push('<span class="tag tag-good">可解锁</span>');
        if (Array.isArray(land.mutantConfigIds) && land.mutantConfigIds.length > 0) {
            tags.push('<span class="tag tag-mutant">已变异</span>');
            for (const label of getMutantTypeLabels(land)) {
                tags.push(`<span class="tag tag-mutant">${label}</span>`);
            }
        }
        return tags.join(' ') || '<span class="muted">正常</span>';
    };
        const getLandCardClass = (land) => {
        const mutantIds = Array.isArray(land && land.mutantConfigIds) ? land.mutantConfigIds.map(v => Number(v) || 0) : [];
        if (mutantIds.includes(4) || mutantIds.includes(1040046)) return 'land-card mutant-heart';
        if (mutantIds.includes(5) || mutantIds.includes(1040112) || mutantIds.includes(1040121)) return 'land-card mutant-gold';
        if (mutantIds.includes(2) || mutantIds.includes(1040025)) return 'land-card mutant-ice';
        if (mutantIds.includes(1040109)) return 'land-card mutant-fire';
        if (mutantIds.length) return 'land-card mutant-generic';
        return 'land-card';
    };
    const renderLandCard = (land) => {
        const mutantLabels = getMutantTypeLabels(land);
        const mutantText = mutantLabels.length ? mutantLabels.join(' / ') : '无';
        const imgUrl = land.seedImage ? toPublicAssetUrl(land.seedImage) : '';
        const imgHtml = imgUrl
            ? `<img class="land-thumb" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(land.plantName || 'crop')}" loading="lazy" />`
            : `<div class="land-thumb land-thumb-fallback">${escapeHtml((land.plantName || '?').slice(0, 2))}</div>`;
        return `<article class="${getLandCardClass(land)}">
          <div class="land-head">
            <div class="land-main">
              ${imgHtml}
              <div>
              <div class="land-title">#${land.id} ${land.plantName || '-'}</div>
              <div class="sub muted">${statusLabelMap[land.status] || land.status || '-'} / ${phaseLabelMap[land.phaseName] || land.phaseName || '-'} · 成熟 ${land.matureInText || '-'}</div>
              </div>
            </div>
            <div class="land-id">地块 ${land.id}</div>
          </div>
          <div class="land-tags">${renderCareBadges(land)}</div>
          <div class="land-mutant">
            <div class="land-mutant-value">${mutantText}</div>
          </div>
        </article>`;
    };
    const renderFriendRow = (friend) => `<tr>
      <td>${friend.gid}</td>
      <td>
        <strong>${friend.remark || friend.name || '-'}</strong>
        <div class="sub muted">${friend.name && friend.remark && friend.name !== friend.remark ? friend.name : ''}</div>
      </td>
      <td>${friend.level || 0}</td>
      <td>${friend.canSteal || 0}</td>
      <td>${friend.dryNum || 0}/${friend.weedNum || 0}/${friend.insectNum || 0}</td>
      <td>${friend.ripeTimeSec || 0}</td>
      <td>${friend.gold || 0}</td>
      <td>${friend.tags && friend.tags.isNew ? '新好友' : '-'} ${friend.tags && friend.tags.isFollow ? '已关注' : ''}</td>
    </tr>`;
    const renderHistoryRow = (item) => `<tr><td>${item.ts || '-'}</td><td>${item.service || '-'}</td><td>${item.method || '-'}</td><td>${item.targetKind || '-'}</td><td><pre>${renderJson(item.summary || {})}</pre></td></tr>`;

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QQ Farm WSS Monitor</title>
  <style>
    :root {
      --bg: #f5efe4;
      --panel: rgba(255,255,255,0.84);
      --line: #d8c7aa;
      --text: #2b241a;
      --muted: #73624b;
      --accent: #0d6e6e;
      --good: #2f855a;
      --warn: #b7791f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at 0% 0%, rgba(255,255,255,0.8), transparent 28%),
        linear-gradient(180deg, #eadfc8, var(--bg));
    }
    .wrap { max-width: 1600px; margin: 0 auto; padding: 20px; }
    .hero, .panel { backdrop-filter: blur(12px); background: var(--panel); border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 12px 32px rgba(61, 43, 15, 0.08); }
    .hero { padding: 20px; margin-bottom: 16px; }
    .hero h1 { margin: 0 0 8px; font-size: 32px; }
    .hero p { margin: 6px 0; color: var(--muted); }
    .hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
    }
    .hero-status {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(2, minmax(180px, 1fr));
      min-width: min(100%, 420px);
    }
    .runtime-pill {
      border-radius: 14px;
      padding: 10px 12px;
      border: 1px solid #e4d5bf;
      background: rgba(255,255,255,0.72);
    }
    .runtime-pill span {
      display: block;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .runtime-pill strong {
      font-size: 15px;
      color: var(--text);
    }
    .runtime-pill-ok {
      background: #edf9f1;
      border-color: #b9e2c6;
    }
    .runtime-pill-off {
      background: #fff3ef;
      border-color: #efc7bb;
    }
    .grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
    .panel { padding: 16px; overflow: hidden; }
    .panel h2 { margin: 0 0 12px; font-size: 18px; }
    .stats { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); margin-bottom: 14px; }
    .stat { border-radius: 14px; padding: 12px; background: #fffaf1; border: 1px solid #e8dbc7; }
    .stat.good { background: #eefbf4; }
    .stat.warn { background: #fff8ea; }
    .stat-value { font-size: 24px; font-weight: 800; }
    .stat-label { color: var(--muted); font-size: 12px; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 9px 8px; border-bottom: 1px solid #eadfcd; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 700; }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 10px; background: #e7f6f5; color: var(--accent); font-size: 12px; font-weight: 700; margin-right: 8px; }
    .share-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      border-radius: 10px;
      background: #0d6e6e;
      color: #fff;
      text-decoration: none;
      font-weight: 700;
      font-size: 13px;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: #33281d; }
    .muted { color: var(--muted); }
    .sub { margin-top: 3px; font-size: 12px; }
    .land-cards {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .land-card {
      border-radius: 22px;
      padding: 14px;
      background: linear-gradient(180deg, #fffaf3, #fff5e8);
      border: 1px solid #e3d2ba;
      box-shadow: 0 10px 24px rgba(68, 46, 19, 0.08);
    }
    .mutant-heart {
      background: linear-gradient(180deg, #fff0f6, #ffe5f0);
      border-color: #efb6d0;
    }
    .mutant-gold {
      background: linear-gradient(180deg, #fff9de, #ffefaa);
      border-color: #e5c86f;
    }
    .mutant-ice {
      background: linear-gradient(180deg, #eef8ff, #dff1ff);
      border-color: #a9d3f2;
    }
    .mutant-fire {
      background: linear-gradient(180deg, #fff1e8, #ffd9c5);
      border-color: #f0ac84;
    }
    .mutant-generic {
      background: linear-gradient(180deg, #f7ecff, #ecdafe);
      border-color: #ccb1ef;
    }
    .land-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 8px;
    }
    .land-main {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      flex: 1;
    }
    .land-thumb {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      object-fit: contain;
      background: rgba(255,255,255,0.82);
      border: 1px solid rgba(122,98,75,0.12);
      padding: 4px;
      flex: 0 0 auto;
    }
    .land-thumb-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 800;
      color: #7a6750;
    }
    .land-title {
      font-size: 18px;
      font-weight: 800;
      line-height: 1.2;
      word-break: break-word;
    }
    .land-id {
      font-size: 12px;
      font-weight: 700;
      color: #7e6a51;
      padding: 6px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.7);
      border: 1px solid rgba(122, 98, 75, 0.15);
      white-space: nowrap;
    }
    .land-tags {
      min-height: 24px;
      margin-bottom: 10px;
    }
    .land-mutant {
      border-radius: 14px;
      padding: 8px 12px;
      background: rgba(255,255,255,0.68);
      border: 1px dashed rgba(122, 98, 75, 0.22);
    }
    .land-mutant-value {
      font-size: 16px;
      font-weight: 800;
      color: #8b4f7a;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 8px;
      margin: 0 6px 6px 0;
      font-size: 12px;
      font-weight: 700;
      background: #f1eadb;
    }
    .tag-water { background: #e8f2ff; color: #1f5ea8; }
    .tag-weed { background: #fff2d8; color: #9a5b00; }
    .tag-bug { background: #ffe3df; color: #b9352b; }
    .tag-good { background: #e7f7ea; color: #237a43; }
    .tag-steal { background: #efe6ff; color: #6b46c1; }
    .tag-mutant { background: #ffe7f3; color: #b83280; }
    @media (max-width: 1320px) {
      .land-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 980px) {
      .hero-status { grid-template-columns: 1fr; min-width: 100%; }
      .land-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .land-cards { grid-template-columns: 1fr; }
    }
  </style>
  <script>
    setTimeout(() => location.reload(), 2500);
  </script>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1>QQ Farm WSS Monitor</h1>
          <p><span class="pill">目标 WSS</span>${TARGET_WS_URL}</p>
          <p><span class="pill">最近更新时间</span>${s.updatedAt || '-'}</p>
          <p><span class="pill">最近帧</span>${s.lastFrame ? `${s.lastFrame.service}.${s.lastFrame.method} / ${s.lastFrame.direction}` : '-'}</p>
        </div>
        <div class="hero-status">
          ${renderRuntimePill('代理状态', runtimeStatus.proxyRunning ? '已启动' : '未启动', runtimeStatus.proxyRunning)}
          ${renderRuntimePill('本地服务', runtimeStatus.serverRunning ? '正常' : '异常', runtimeStatus.serverRunning)}
          ${renderRuntimePill('最近抓包时间', runtimeStatus.lastCaptureAt || '暂无', !!runtimeStatus.lastCaptureAt)}
          ${renderRuntimePill('当前好友数据', runtimeStatus.hasFriendData ? '存在' : '暂无', runtimeStatus.hasFriendData)}
        </div>
      </div>
    </section>
    <section class="grid">
      <section class="panel">
        <div class="panel-head">
          <h2>我的农场</h2>
          <a class="share-link" href="/share/farm.png" target="_blank" rel="noreferrer">导出 PNG 截图</a>
        </div>
        <div class="stats">
          ${renderSummaryCard('土地总数', farm.summary && farm.summary.total, '')}
          ${renderSummaryCard('可收获', farm.summary && farm.summary.harvestable, 'good')}
          ${renderSummaryCard('生长中', farm.summary && farm.summary.growing, '')}
          ${renderSummaryCard('缺水', farm.summary && farm.summary.needWater, 'warn')}
          ${renderSummaryCard('长草', farm.summary && farm.summary.needWeed, 'warn')}
          ${renderSummaryCard('生虫', farm.summary && farm.summary.needBug, 'warn')}
        </div>
        ${farmLands.length ? `<div class="land-cards">${farmLands.map(renderLandCard).join('')}</div>` : '<div class="muted">暂无数据</div>'}
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>当前访问好友</h2>
          <a class="share-link" href="/share/friend.png" target="_blank" rel="noreferrer">导出 PNG 截图</a>
        </div>
        <div class="stats">
          ${renderSummaryCard('好友', visit.friend && (visit.friend.remark || visit.friend.name), '')}
          ${renderSummaryCard('等级', visit.friend && visit.friend.level, '')}
          ${renderSummaryCard('可收获', visit.summary && visit.summary.harvestable, 'good')}
          ${renderSummaryCard('缺水', visit.summary && visit.summary.needWater, 'warn')}
          ${renderSummaryCard('长草', visit.summary && visit.summary.needWeed, 'warn')}
          ${renderSummaryCard('生虫', visit.summary && visit.summary.needBug, 'warn')}
        </div>
        ${visitLands.length ? `<div class="land-cards">${visitLands.map(renderLandCard).join('')}</div>` : '<div class="muted">暂无好友农场数据</div>'}
      </section>
      <section class="panel">
        <h2>好友摘要</h2>
        <div class="stats">
          ${renderSummaryCard('好友总数', friendList.summary && friendList.summary.total, '')}
          ${renderSummaryCard('可偷好友', friendList.summary && friendList.summary.stealableFriends, 'good')}
          ${renderSummaryCard('需帮忙好友', friendList.summary && friendList.summary.needHelpFriends, 'warn')}
        </div>
        <table><thead><tr><th>GID</th><th>好友</th><th>等级</th><th>可偷</th><th>缺水/草/虫</th><th>成熟秒数</th><th>金币</th><th>标签</th></tr></thead><tbody>${friends.map(renderFriendRow).join('') || '<tr><td colspan="8" class="muted">暂无好友列表数据</td></tr>'}</tbody></table>
      </section>
    </section>
    <section class="panel" style="margin-top:16px;">
      <h2>最近消息</h2>
      <table><thead><tr><th>时间</th><th>服务</th><th>方法</th><th>类别</th><th>摘要</th></tr></thead><tbody>${history.map(renderHistoryRow).join('') || '<tr><td colspan="5" class="muted">暂无历史</td></tr>'}</tbody></table>
    </section>
  </div>
</body>
</html>`;
}

function getMutantLabelsForShare(land) {
    const mutantLabelByConfigId = {
        1: '冰冻',
        2: '冰冻',
        3: '暗化',
        4: '湿润',
        5: '黄金',
        6: '稀世',
        1040046: '爱心',
        1040025: '冰冻',
        1040109: '火焰',
        1040112: '黄金',
        1040121: '黄金',
        1040224: '幽灵',
        1040249: '稀世',
    };
    const labels = [];
    const plantName = String(land && land.plantName || '').trim();
    const mutantIds = Array.isArray(land && land.mutantConfigIds) ? land.mutantConfigIds : [];
    for (const id of mutantIds) {
        const label = mutantLabelByConfigId[Number(id) || 0];
        if (label) labels.push(label);
    }
    const hasExplicitMutant = mutantIds.length > 0;
    if (!hasExplicitMutant) {
        if (plantName.startsWith('变异')) labels.push('普通变异');
        if (plantName.includes('爱心·') || plantName.includes('·爱心')) labels.push('爱心');
        if (plantName.includes('黄金·') || plantName.includes('·黄金')) labels.push('黄金');
        if (plantName.includes('冰冻')) labels.push('冰冻');
        if (plantName.includes('火焰')) labels.push('火焰');
        if (plantName.includes('幽灵')) labels.push('幽灵');
        if (plantName.includes('稀世')) labels.push('稀世');
    }
    if (hasExplicitMutant && labels.length === 0) {
        labels.push(`未知变异(${mutantIds.join(',')})`);
    }
    return [...new Set(labels)];
}

function buildShareSvg(title, subtitle, lands, meta = {}) {
    const list = Array.isArray(lands) ? lands : [];
    const cols = 4;
    const cardWidth = 268;
    const cardHeight = 144;
    const gapX = 16;
    const gapY = 16;
    const width = 1200;
    const headerLines = Array.isArray(meta.headerLines) ? meta.headerLines.filter(Boolean) : [];
    const top = 178 + headerLines.length * 28;
    const rowsCount = Math.max(1, Math.ceil(list.length / cols));
    const height = Math.max(360, top + rowsCount * (cardHeight + gapY) + 32);

    const statusMap = {
        locked: '未解锁',
        empty: '空地',
        growing: '生长中',
        harvestable: '可收获',
        dead: '枯萎',
    };
    const phaseMap = {
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

    const summary = [
        `地块 ${meta.total ?? list.length}`,
        `可收获 ${meta.harvestable ?? 0}`,
        `缺水 ${meta.needWater ?? 0}`,
        `长草 ${meta.needWeed ?? 0}`,
        `生虫 ${meta.needBug ?? 0}`,
    ].join('  ·  ');
    const headerText = headerLines.map((line, index) =>
        `<text x="48" y="${146 + index * 26}" font-size="22" fill="#8a735a">${escapeXml(line)}</text>`
    ).join('\n');
    const summaryY = 146 + headerLines.length * 26;
    const truncateText = (value, maxChars) => {
        const text = String(value || '');
        return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
    };

    const getShareCardStyle = (land) => {
        const mutantIds = Array.isArray(land && land.mutantConfigIds) ? land.mutantConfigIds.map(v => Number(v) || 0) : [];
        if (mutantIds.includes(4) || mutantIds.includes(1040046)) {
            return {
                fill: 'url(#cardHeart)',
                stroke: '#efb6d0',
                mutantColor: '#b83280',
            };
        }
        if (mutantIds.includes(5) || mutantIds.includes(1040112) || mutantIds.includes(1040121)) {
            return {
                fill: 'url(#cardGold)',
                stroke: '#e5c86f',
                mutantColor: '#9a6a00',
            };
        }
        if (mutantIds.includes(2) || mutantIds.includes(1040025)) {
            return {
                fill: 'url(#cardIce)',
                stroke: '#a9d3f2',
                mutantColor: '#1f5ea8',
            };
        }
        if (mutantIds.includes(1040109)) {
            return {
                fill: 'url(#cardFire)',
                stroke: '#f0ac84',
                mutantColor: '#b44a1f',
            };
        }
        if (mutantIds.length) {
            return {
                fill: 'url(#cardMutant)',
                stroke: '#ccb1ef',
                mutantColor: '#7b43b7',
            };
        }
        return {
            fill: 'url(#cardNormal)',
            stroke: '#e3d2ba',
            mutantColor: '#8b4f7a',
        };
    };

    const rows = list.map((land, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const x = 40 + col * (cardWidth + gapX);
        const y = top + row * (cardHeight + gapY);
        const mutantLabels = getMutantLabelsForShare(land);
        const style = getShareCardStyle(land);
        const imageDataUri = land.seedImage ? getInlineImageDataUri(land.seedImage) : '';
        const tags = [];
        if (land.needWater) tags.push({ text: '缺水', fill: '#e8f2ff', color: '#1f5ea8' });
        if (land.needWeed) tags.push({ text: '长草', fill: '#fff2d8', color: '#9a5b00' });
        if (land.needBug) tags.push({ text: '生虫', fill: '#ffe3df', color: '#b9352b' });
        if (land.stealable) tags.push({ text: '可偷', fill: '#efe6ff', color: '#6b46c1' });
        if (land.couldUpgrade) tags.push({ text: '可升级', fill: '#e7f7ea', color: '#237a43' });
        if (land.couldUnlock) tags.push({ text: '可解锁', fill: '#e7f7ea', color: '#237a43' });
        if (Array.isArray(land.mutantConfigIds) && land.mutantConfigIds.length > 0) {
            tags.push({ text: '已变异', fill: '#ffe7f3', color: '#b83280' });
            for (const label of mutantLabels) {
                tags.push({ text: label, fill: '#ffe7f3', color: '#b83280' });
            }
        }
        const line1 = truncateText(`#${land.id} ${land.plantName || '空地'}`, 11);
        const line2 = truncateText(`${statusMap[land.status] || land.status || '-'} / ${phaseMap[land.phaseName] || land.phaseName || '-'} · 成熟 ${land.matureInText || '-'}`, 23);
        const line3 = truncateText(mutantLabels.length ? mutantLabels.join(' / ') : '无', 12);
        let pillX = 16;
        const pillsSvg = tags.slice(0, 3).map((tag) => {
            const width = Math.max(48, 18 + String(tag.text).length * 16);
            const pill = `
    <g transform="translate(${pillX}, 72)">
      <rect x="0" y="0" width="${width}" height="28" rx="14" fill="${tag.fill}"/>
      <text x="${width / 2}" y="20" font-size="13" font-weight="700" text-anchor="middle" fill="${tag.color}">${escapeXml(tag.text)}</text>
    </g>`;
            pillX += width + 10;
            return pill;
        }).join('');
        const imageSvg = imageDataUri
            ? `
    <rect x="16" y="14" width="56" height="56" rx="14" fill="rgba(255,255,255,0.88)" stroke="rgba(122,98,75,0.12)"/>
    <image x="22" y="20" width="44" height="44" href="${imageDataUri}" preserveAspectRatio="xMidYMid meet"/>`
            : `
    <rect x="16" y="14" width="56" height="56" rx="14" fill="rgba(255,255,255,0.88)" stroke="rgba(122,98,75,0.12)"/>
    <text x="44" y="48" text-anchor="middle" font-size="12" font-weight="700" fill="#7a6750">${escapeXml((land.plantName || '?').slice(0, 2))}</text>`;
        return `
  <g transform="translate(${x}, ${y})">
    <rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="22" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"/>
    <rect x="14" y="104" width="${cardWidth - 28}" height="28" rx="14" fill="rgba(255,255,255,0.76)" stroke="rgba(122,98,75,0.16)" stroke-dasharray="4 4"/>
    ${imageSvg}
    <text x="84" y="30" font-size="18" font-weight="700" fill="#2f261c">${escapeXml(line1)}</text>
    <text x="84" y="52" font-size="13" fill="#6d5c45">${escapeXml(line2)}</text>
    ${pillsSvg}
    <text x="16" y="124" font-size="17" font-weight="800" fill="${style.mutantColor}">${escapeXml(line3)}</text>
  </g>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f3ead8" />
      <stop offset="100%" stop-color="#efe3cf" />
    </linearGradient>
    <linearGradient id="cardNormal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fffaf3" />
      <stop offset="100%" stop-color="#fff5e8" />
    </linearGradient>
    <linearGradient id="cardHeart" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fff0f6" />
      <stop offset="100%" stop-color="#ffe5f0" />
    </linearGradient>
    <linearGradient id="cardGold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fff9de" />
      <stop offset="100%" stop-color="#ffefaa" />
    </linearGradient>
    <linearGradient id="cardIce" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eef8ff" />
      <stop offset="100%" stop-color="#dff1ff" />
    </linearGradient>
    <linearGradient id="cardFire" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fff1e8" />
      <stop offset="100%" stop-color="#ffd9c5" />
    </linearGradient>
    <linearGradient id="cardMutant" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f7ecff" />
      <stop offset="100%" stop-color="#ecdafe" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="30" fill="#fffcf6" stroke="#dcc7a8"/>
  <text x="48" y="78" font-size="42" font-weight="800" fill="#3a2d1f">${escapeXml(title)}</text>
  <text x="48" y="116" font-size="24" fill="#7a6750">${escapeXml(subtitle)}</text>
  ${headerText}
  <text x="48" y="${summaryY}" font-size="22" fill="#8a735a">${escapeXml(summary)}</text>
  ${rows || '<text x="48" y="240" font-size="28" fill="#7a6750">暂无可分享的土地数据</text>'}
</svg>`;
}

function svgToPngBuffer(svgText) {
    const resvg = new Resvg(svgText, {
        fitTo: {
            mode: 'width',
            value: 1200,
        },
    });
    const pngData = resvg.render();
    return pngData.asPng();
}

function writeBinaryFrame(baseDir, entry, buffer, decoded) {
    const dateDir = path.join(baseDir, nowForFile());
    ensureDir(dateDir);

    const service = sanitizeSegment(decoded && decoded.service, 'unknown-service');
    const method = sanitizeSegment(decoded && decoded.method, 'unknown-method');
    const direction = sanitizeSegment(entry.direction, 'unknown-direction');
    const stamp = nowForStamp();
    const prefix = `${stamp}.${direction}.${service}.${method}`;

    const binFile = path.join(dateDir, `${prefix}.bin`);
    fs.writeFileSync(binFile, buffer);

    let metaFile = '';
    let cnJsonFile = '';

    const meta = {
        ts: entry.ts,
        source: entry.source,
        url: entry.url,
        direction: entry.direction,
        messageType: entry.messageType,
        opcode: entry.opcode || 0,
        remoteIp: entry.remoteIp,
        service: decoded && decoded.service ? decoded.service : '',
        method: decoded && decoded.method ? decoded.method : '',
        isTarget: !!(decoded && decoded.isTarget),
        gateMeta: decoded && decoded.gateJson ? (decoded.gateJson.meta || {}) : {},
        summary: decoded && decoded.summary ? decoded.summary : null,
        raw: entry.raw,
    };

    metaFile = path.join(dateDir, `${prefix}.json`);
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    if (decoded && decoded.cnJson) {
        cnJsonFile = path.join(dateDir, `${prefix}.cn.json`);
        fs.writeFileSync(cnJsonFile, `${JSON.stringify(decoded.cnJson, null, 2)}\n`, 'utf8');
    }

    return { binFile, metaFile, cnJsonFile };
}

async function handleMitmFrame(payload, remoteIp) {
    const entry = buildMitmEntry(payload, remoteIp);
    const allFile = appendJsonLine(DEFAULT_LOG_DIR, 'mitm-ws-all', entry);

    if (!entry.matched) {
        return {
            ok: true,
            matched: false,
            saved: false,
            allFile,
        };
    }

    appendJsonLine(DEFAULT_LOG_DIR, 'qq-farm-gate-ws', entry);

    const { isBinary } = getMessageTypeFlags(entry.messageType, entry.opcode);
    if (!isBinary) {
        return {
            ok: true,
            matched: true,
            saved: false,
            reason: 'non-binary-frame',
            allFile,
        };
    }

    const buffer = decodeBase64ToBuffer(entry.base64);
    const decoded = await tryDecodeGateMessage(buffer);
    const files = writeBinaryFrame(path.join(DEFAULT_LOG_DIR, 'frames'), entry, buffer, decoded);
    updateRuntimeState(entry, decoded);

    return {
        ok: true,
        matched: true,
        saved: true,
        decoded: decoded.ok,
        isTarget: !!decoded.isTarget,
        service: decoded.service || '',
        method: decoded.method || '',
        summary: decoded.summary || null,
        error: decoded.error || '',
        allFile,
        ...files,
    };
}

async function startServer() {
    await ensureRuntime();

    const app = express();
    app.use('/game-config', express.static(path.join(PROJECT_ROOT, 'game-config')));
    app.use(express.json({ limit: '20mb' }));

    app.get('/healthz', (req, res) => {
        res.json({ ok: true, target: TARGET_WS_URL, port: DEFAULT_PORT });
    });

    app.get('/api/state', (req, res) => {
        res.json({ ok: true, data: cloneState() });
    });

    app.get('/api/latest-alllands-cnjson-meta', (req, res) => {
        const file = getLatestAllLandsCnJsonFile();
        res.json({
            ok: !!file,
            file,
        });
    });

    app.get('/api/latest-alllands-cnjson', (req, res) => {
        const file = getLatestAllLandsCnJsonFile();
        if (!file || !fs.existsSync(file)) {
            res.status(404).json({ ok: false, error: 'latest AllLands.cn.json not found' });
            return;
        }
        res.type('application/json').send(fs.readFileSync(file, 'utf8'));
    });

    app.get('/share/farm.svg', (req, res) => {
        const state = cloneState();
        const farm = state.farm || {};
        const summary = farm.summary || {};
        const svg = buildShareSvg(
            'QQ 农场土地播报',
            `我的农场 · ${farm.ts || '暂无时间'}`,
            Array.isArray(farm.lands) ? farm.lands : [],
            {
                headerLines: [
                    `来源: 自己的农场`,
                ],
                total: summary.total || 0,
                harvestable: summary.harvestable || 0,
                needWater: summary.needWater || 0,
                needWeed: summary.needWeed || 0,
                needBug: summary.needBug || 0,
            },
        );
        res.type('image/svg+xml').send(svg);
    });

    app.get('/share/farm.png', (req, res) => {
        const state = cloneState();
        const farm = state.farm || {};
        const summary = farm.summary || {};
        const svg = buildShareSvg(
            'QQ 农场土地播报',
            `我的农场 · ${farm.ts || '暂无时间'}`,
            Array.isArray(farm.lands) ? farm.lands : [],
            {
                headerLines: [
                    `来源: 自己的农场`,
                ],
                total: summary.total || 0,
                harvestable: summary.harvestable || 0,
                needWater: summary.needWater || 0,
                needWeed: summary.needWeed || 0,
                needBug: summary.needBug || 0,
            },
        );
        res.type('image/png').send(svgToPngBuffer(svg));
    });

    app.get('/share/friend.svg', (req, res) => {
        const state = cloneState();
        const visit = state.currentVisit || {};
        const summary = visit.summary || {};
        const friendName = visit.friend && (visit.friend.remark || visit.friend.name) ? (visit.friend.remark || visit.friend.name) : '好友农场';
        const rawName = visit.friend && visit.friend.name ? visit.friend.name : '';
        const gid = visit.friend && visit.friend.gid ? visit.friend.gid : '';
        const level = visit.friend && visit.friend.level ? visit.friend.level : '';
        const svg = buildShareSvg(
            'QQ 农场好友土地播报',
            `${friendName} · ${visit.ts || '暂无时间'}`,
            Array.isArray(visit.lands) ? visit.lands : [],
            {
                headerLines: [
                    `好友昵称: ${friendName}`,
                    rawName && rawName !== friendName ? `原始昵称: ${rawName}` : '',
                    `好友GID: ${gid || '-'}  ·  等级: ${level || '-'}`,
                ],
                total: summary.total || 0,
                harvestable: summary.harvestable || 0,
                needWater: summary.needWater || 0,
                needWeed: summary.needWeed || 0,
                needBug: summary.needBug || 0,
            },
        );
        res.type('image/svg+xml').send(svg);
    });

    app.get('/share/friend.png', (req, res) => {
        const state = cloneState();
        const visit = state.currentVisit || {};
        const summary = visit.summary || {};
        const friendName = visit.friend && (visit.friend.remark || visit.friend.name) ? (visit.friend.remark || visit.friend.name) : '好友农场';
        const rawName = visit.friend && visit.friend.name ? visit.friend.name : '';
        const gid = visit.friend && visit.friend.gid ? visit.friend.gid : '';
        const level = visit.friend && visit.friend.level ? visit.friend.level : '';
        const svg = buildShareSvg(
            'QQ 农场好友土地播报',
            `${friendName} · ${visit.ts || '暂无时间'}`,
            Array.isArray(visit.lands) ? visit.lands : [],
            {
                headerLines: [
                    `好友昵称: ${friendName}`,
                    rawName && rawName !== friendName ? `原始昵称: ${rawName}` : '',
                    `好友GID: ${gid || '-'}  ·  等级: ${level || '-'}`,
                ],
                total: summary.total || 0,
                harvestable: summary.harvestable || 0,
                needWater: summary.needWater || 0,
                needWeed: summary.needWeed || 0,
                needBug: summary.needBug || 0,
            },
        );
        res.type('image/png').send(svgToPngBuffer(svg));
    });

    app.get('/', (req, res) => {
        res.type('html').send(renderMonitorPage(cloneState()));
    });

    app.post('/reqable/ws-log', (req, res) => {
        const entry = buildLogEntry(req.body, req.ip || '');
        const allFile = appendJsonLine(DEFAULT_LOG_DIR, 'reqable-ws-all', entry);

        let targetFile = '';
        if (entry.matched) {
            targetFile = appendJsonLine(DEFAULT_LOG_DIR, 'qq-farm-gate-ws', entry);
        }

        res.json({
            ok: true,
            matched: entry.matched,
            allFile,
            targetFile,
        });
    });

    app.post('/reqable/ws-batch', (req, res) => {
        const list = Array.isArray(req.body) ? req.body : [];
        let matched = 0;
        let allCount = 0;
        let targetFile = '';

        for (const item of list) {
            const entry = buildLogEntry(item, req.ip || '');
            appendJsonLine(DEFAULT_LOG_DIR, 'reqable-ws-all', entry);
            allCount++;
            if (entry.matched) {
                targetFile = appendJsonLine(DEFAULT_LOG_DIR, 'qq-farm-gate-ws', entry);
                matched++;
            }
        }

        res.json({
            ok: true,
            total: allCount,
            matched,
            targetFile,
        });
    });

    app.post('/mitm/ws-frame', async (req, res) => {
        try {
            const result = await handleMitmFrame(req.body, req.ip || '');
            res.json(result);
        } catch (error) {
            res.status(500).json({
                ok: false,
                error: error && error.stack ? error.stack : String(error),
            });
        }
    });

    app.post('/reqable/debug', (req, res) => {
        const file = appendJsonLine(DEFAULT_LOG_DIR, 'reqable-debug', {
            ts: nowForLine(),
            body: req.body,
        });
        res.json({ ok: true, file });
    });

    app.listen(DEFAULT_PORT, '127.0.0.1', () => {
        process.stdout.write(`WS log server listening on http://127.0.0.1:${DEFAULT_PORT}\n`);
        process.stdout.write(`Target websocket: ${TARGET_WS_URL}\n`);
        process.stdout.write(`Log dir: ${DEFAULT_LOG_DIR}\n`);
        process.stdout.write(`MITM endpoint: http://127.0.0.1:${DEFAULT_PORT}/mitm/ws-frame\n`);
    });
}

startServer().catch((error) => {
    process.stderr.write(`${safeJson({ error: error && error.message ? error.message : String(error) })}\n`);
    process.exit(1);
});
