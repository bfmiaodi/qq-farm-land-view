#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {
    ensureDir,
    resolveRun,
} = require('./runtime-paths');

const runDir = resolveRun();
const pidFile = path.join(runDir, 'farm-monitor.json');

function ensureRunDir() {
    ensureDir(runDir);
}

function readPidInfo() {
    if (!fs.existsSync(pidFile)) return null;
    try {
        return JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    } catch {
        return null;
    }
}

function writePidInfo(info) {
    ensureRunDir();
    fs.writeFileSync(pidFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

function clearPidInfo() {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function checkPortOpen(port, host = '127.0.0.1', timeoutMs = 400) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const done = (result) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

module.exports = {
    pidFile,
    readPidInfo,
    writePidInfo,
    clearPidInfo,
    isPidAlive,
    checkPortOpen,
};

