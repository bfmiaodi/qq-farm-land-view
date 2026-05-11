#!/usr/bin/env node

const path = require('node:path');
const { spawn } = require('node:child_process');

function pad2(value) {
    return String(value).padStart(2, '0');
}

function buildStamp(date = new Date()) {
    const y = date.getFullYear();
    const m = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    const hh = pad2(date.getHours());
    const mm = pad2(date.getMinutes());
    const ss = pad2(date.getSeconds());
    return `${y}${m}${d}-${hh}${mm}${ss}`;
}

const outputDir = `dist-release-${buildStamp()}`;
const cli = path.join(process.cwd(), 'node_modules', 'electron-builder', 'cli.js');

const child = spawn(process.execPath, [cli, '--win', 'nsis', `--config.directories.output=${outputDir}`], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code || 0);
});
