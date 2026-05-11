#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourceRoot = path.resolve(__dirname, '..');
const isPackagedDesktop = process.env.QQFARM_PACKAGED === '1';
const appRoot = process.env.QQFARM_APP_ROOT
    ? path.resolve(process.env.QQFARM_APP_ROOT)
    : sourceRoot;
const dataRoot = process.env.QQFARM_DATA_ROOT
    ? path.resolve(process.env.QQFARM_DATA_ROOT)
    : (isPackagedDesktop ? path.join(os.homedir(), 'AppData', 'Roaming', 'QQFarmMonitor') : appRoot);
const resourceRoot = process.env.QQFARM_RESOURCE_ROOT
    ? path.resolve(process.env.QQFARM_RESOURCE_ROOT)
    : appRoot;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function resolveResource(...segments) {
    return path.join(resourceRoot, ...segments);
}

function resolveData(...segments) {
    return path.join(dataRoot, ...segments);
}

function resolveRun(...segments) {
    return path.join(dataRoot, '.run', ...segments);
}

function resolveMitmExecutable() {
    if (process.env.QQFARM_MITMDUMP_PATH) {
        const value = String(process.env.QQFARM_MITMDUMP_PATH).trim();
        if (!value) return 'mitmdump';
        if (path.isAbsolute(value)) return path.resolve(value);
        if (value.includes('/') || value.includes('\\')) return path.resolve(value);
        return value;
    }

    if (process.platform === 'win32') {
        const bundledDevPath = sourceRoot ? path.join(sourceRoot, 'vendor', 'mitmproxy', 'win', 'mitmdump.exe') : '';
        if (bundledDevPath && fs.existsSync(bundledDevPath)) {
            return bundledDevPath;
        }
    }

    if (process.platform === 'win32' && isPackagedDesktop) {
        return resolveResource('bin', 'mitmdump.exe');
    }

    return 'mitmdump';
}

module.exports = {
    sourceRoot,
    appRoot,
    dataRoot,
    resourceRoot,
    isPackagedDesktop,
    ensureDir,
    resolveResource,
    resolveData,
    resolveRun,
    resolveMitmExecutable,
};
