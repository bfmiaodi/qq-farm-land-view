#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const gameConfigDir = path.join(projectRoot, 'game-config');

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        html: false,
        json: false,
        out: '',
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--html') {
            options.html = true;
            continue;
        }
        if (arg === '--json') {
            options.json = true;
            continue;
        }
        if (arg === '--out') {
            const next = args[i + 1];
            if (!next || next.startsWith('--')) {
                throw new Error('Missing value for --out');
            }
            options.out = path.resolve(process.cwd(), next);
            i++;
            continue;
        }
        if (arg.startsWith('--out=')) {
            options.out = path.resolve(process.cwd(), arg.slice('--out='.length));
        }
    }

    if (!options.html && !options.json) {
        options.html = true;
    }

    return options;
}

function loadJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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

function toNum(value) {
    return Number(value || 0);
}

function parseGrowSeconds(growPhases, seasons) {
    const phases = String(growPhases || '')
        .split(';')
        .map(item => item.trim())
        .filter(Boolean);

    const durations = phases.map((item) => {
        const match = item.match(/:(\d+)/);
        return match ? Number(match[1]) || 0 : 0;
    });

    const total = durations.reduce((sum, item) => sum + item, 0);
    if (Number(seasons) !== 2) return total;

    const lastTwo = durations.filter(item => item > 0).slice(-2);
    return total + lastTwo.reduce((sum, item) => sum + item, 0);
}

function formatDuration(sec) {
    const total = Math.max(0, toNum(sec));
    const day = Math.floor(total / 86400);
    const hour = Math.floor((total % 86400) / 3600);
    const minute = Math.floor((total % 3600) / 60);
    const second = total % 60;
    const parts = [];
    if (day) parts.push(`${day}d`);
    if (hour) parts.push(`${hour}h`);
    if (minute) parts.push(`${minute}m`);
    if (second || parts.length === 0) parts.push(`${second}s`);
    return parts.join(' ');
}

function buildSeedImageMaps(seedDir) {
    const bySeedId = new Map();
    const byAssetName = new Map();

    for (const file of fs.readdirSync(seedDir)) {
        const byId = file.match(/^(\d+)_.*\.(?:png|jpg|jpeg|webp|gif)$/i);
        if (byId) {
            const seedId = Number(byId[1]) || 0;
            if (seedId > 0 && !bySeedId.has(seedId)) {
                bySeedId.set(seedId, `./game-config/seed_images_named/${file}`);
            }
        }

        const byAsset = file.match(/(Crop_\d+)_Seed\.(?:png|jpg|jpeg|webp|gif)$/i);
        if (byAsset && !byAssetName.has(byAsset[1])) {
            byAssetName.set(byAsset[1], `./game-config/seed_images_named/${file}`);
        }
    }

    return { bySeedId, byAssetName };
}

function buildCatalog() {
    const plants = loadJson(path.join(gameConfigDir, 'Plant.json'));
    const items = loadJson(path.join(gameConfigDir, 'ItemInfo.json'));
    const seedDir = path.join(gameConfigDir, 'seed_images_named');
    const imageMaps = buildSeedImageMaps(seedDir);

    const itemsById = new Map();
    for (const item of items) {
        const id = toNum(item.id);
        if (id > 0) itemsById.set(id, item);
    }

    const rows = plants.map((plant) => {
        const plantId = toNum(plant.id);
        const seedId = toNum(plant.seed_id);
        const fruitId = toNum(plant.fruit && plant.fruit.id);
        const seedItem = itemsById.get(seedId) || null;
        const fruitItem = itemsById.get(fruitId) || null;
        const growSeconds = parseGrowSeconds(plant.grow_phases, plant.seasons);
        const assetName = seedItem && seedItem.asset_name ? String(seedItem.asset_name) : '';
        const seedImage = imageMaps.bySeedId.get(seedId) || imageMaps.byAssetName.get(assetName) || '';

        return {
            plantId,
            name: String(plant.name || ''),
            seedId,
            fruitId,
            requiredLevel: toNum(plant.land_level_need),
            size: Math.max(1, toNum(plant.size) || 1),
            seasons: toNum(plant.seasons),
            exp: toNum(plant.exp),
            growPhases: String(plant.grow_phases || ''),
            growSeconds,
            growDuration: formatDuration(growSeconds),
            seedPrice: seedItem ? toNum(seedItem.price) : 0,
            seedPriceType: seedItem ? toNum(seedItem.price_id) : 0,
            fruitPrice: fruitItem ? toNum(fruitItem.price) : 0,
            assetName,
            rarity: seedItem ? toNum(seedItem.rarity) : 0,
            desc: seedItem ? String(seedItem.desc || '') : '',
            effectDesc: seedItem ? String(seedItem.effectDesc || '') : '',
            seedImage,
        };
    });

    rows.sort((a, b) => a.requiredLevel - b.requiredLevel || a.plantId - b.plantId);

    return {
        generatedAt: new Date().toISOString(),
        total: rows.length,
        rows,
    };
}

function renderHtml(catalog, outputFile) {
    const cards = catalog.rows.map((row) => `
      <article class="card">
        <div class="card-top">
          <div class="img-wrap">
            ${row.seedImage ? `<img src="${escapeHtml(getRelativeAssetPath(outputFile, row.seedImage))}" alt="${escapeHtml(row.name)}">` : '<div class="img-empty">No Image</div>'}
          </div>
          <div class="meta">
            <h2>${escapeHtml(row.name)}</h2>
            <p>Plant ID ${escapeHtml(row.plantId)} / Seed ID ${escapeHtml(row.seedId)}</p>
            <div class="tags">
              <span>Lv.${escapeHtml(row.requiredLevel)}</span>
              <span>${escapeHtml(row.growDuration)}</span>
              <span>${escapeHtml(`${row.size}格`)}</span>
            </div>
          </div>
        </div>
        <div class="grid">
          <div><strong>果实ID</strong><span>${escapeHtml(row.fruitId || '-')}</span></div>
          <div><strong>经验</strong><span>${escapeHtml(row.exp)}</span></div>
          <div><strong>种子价格</strong><span>${escapeHtml(row.seedPrice)}</span></div>
          <div><strong>果实价格</strong><span>${escapeHtml(row.fruitPrice)}</span></div>
          <div><strong>资产名</strong><span>${escapeHtml(row.assetName || '-')}</span></div>
          <div><strong>季数</strong><span>${escapeHtml(row.seasons)}</span></div>
        </div>
        <details>
          <summary>更多信息</summary>
          <pre>${escapeHtml(JSON.stringify(row, null, 2))}</pre>
        </details>
      </article>
    `).join('\n');

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QQ农场作物图鉴</title>
  <style>
    :root {
      --bg: #f6f0e4;
      --panel: #fffaf2;
      --line: #dcc9a7;
      --text: #35271a;
      --muted: #7b634d;
      --accent: #2f8f4e;
      --shadow: 0 18px 40px rgba(76, 54, 22, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.65), transparent 28%),
        linear-gradient(180deg, #f3ead9, var(--bg));
    }
    .wrap {
      max-width: 1280px;
      margin: 0 auto;
      padding: 28px 18px 48px;
    }
    .hero {
      margin-bottom: 24px;
      padding: 24px;
      border-radius: 24px;
      background: linear-gradient(135deg, #fff9ee, #f6ead3);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 34px;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 20px;
      background: var(--panel);
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .card-top {
      display: flex;
      gap: 14px;
      margin-bottom: 12px;
    }
    .img-wrap {
      width: 88px;
      height: 88px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      flex: 0 0 auto;
    }
    .img-wrap img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      padding: 6px;
    }
    .img-empty {
      font-size: 12px;
      color: var(--muted);
    }
    .meta h2 {
      margin: 0 0 6px;
      font-size: 22px;
    }
    .meta p {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 13px;
    }
    .tags {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tags span {
      display: inline-flex;
      padding: 4px 10px;
      border-radius: 999px;
      background: #ecf8ee;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .grid div {
      border: 1px solid #efe0c4;
      border-radius: 12px;
      padding: 10px;
      background: #fffdf8;
    }
    .grid strong {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .grid span {
      font-weight: 700;
      word-break: break-word;
    }
    details {
      margin-top: 12px;
    }
    pre {
      margin: 8px 0 0;
      padding: 12px;
      border-radius: 12px;
      background: #281d13;
      color: #f8efdf;
      overflow: auto;
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 640px) {
      .card-top { align-items: flex-start; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>QQ 农场作物图鉴</h1>
      <p>共 ${escapeHtml(catalog.total)} 种作物，包含名称、等级、价格、生长时间与种子图片。</p>
    </section>
    <section class="cards">${cards}</section>
  </div>
</body>
</html>`;
}

function getRelativeAssetPath(outputFile, assetPath) {
    if (!assetPath) return '';
    const abs = path.resolve(projectRoot, assetPath.replace(/^\.\//, ''));
    let rel = path.relative(path.dirname(outputFile), abs).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel;
}

function main() {
    const options = parseArgs();
    const catalog = buildCatalog();

    if (options.json) {
        const file = options.out || path.join(projectRoot, 'crop-catalog.json');
        ensureDirForFile(file);
        fs.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
        process.stdout.write(`JSON written to: ${file}\n`);
        return;
    }

    const file = options.out || path.join(projectRoot, 'crop-catalog.html');
    ensureDirForFile(file);
    fs.writeFileSync(file, renderHtml(catalog, file), 'utf8');
    process.stdout.write(`HTML written to: ${file}\n`);
}

main();
