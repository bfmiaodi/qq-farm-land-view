#!/usr/bin/env node

const {
    readPidInfo,
    clearPidInfo,
    isPidAlive,
} = require('./process-manager');

function killIfAlive(pid, label) {
    if (!pid) return;
    if (!isPidAlive(pid)) return;
    try {
        process.kill(pid, 'SIGINT');
        process.stdout.write(`[stop] sent SIGINT to ${label} pid=${pid}\n`);
    } catch (error) {
        process.stderr.write(`[stop] failed to stop ${label} pid=${pid}: ${error.message}\n`);
    }
}

const info = readPidInfo();
if (!info) {
    process.stdout.write('[stop] no running process info found\n');
    process.exit(0);
}

killIfAlive(info.serverPid, 'server');
killIfAlive(info.mitmPid, 'mitm');
killIfAlive(info.mainPid, 'main');
clearPidInfo();
process.stdout.write('[stop] done\n');

