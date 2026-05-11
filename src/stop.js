#!/usr/bin/env node

const {
    readPidInfo,
    clearPidInfo,
    isPidAlive,
} = require('./process-manager');
const {
    restoreWindowsSystemProxy,
    disableWindowsSystemProxy,
} = require('./windows-proxy');
const {
    restoreMacOSSystemProxy,
    disableMacOSSystemProxy,
} = require('./macos-proxy');

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

(async () => {
    const info = readPidInfo();
    if (!info) {
        try {
            await disableWindowsSystemProxy();
            await disableMacOSSystemProxy();
            process.stdout.write('[stop] no running process info found, disabled system proxy\n');
        } catch (error) {
            process.stdout.write('[stop] no running process info found\n');
            process.stderr.write(`[stop] failed to disable system proxy: ${error.message}\n`);
        }
        process.exit(0);
    }

    killIfAlive(info.serverPid, 'server');
    killIfAlive(info.mitmPid, 'mitm');
    killIfAlive(info.mainPid, 'main');

    if (info.windowsProxyState) {
        try {
            await restoreWindowsSystemProxy(info.windowsProxyState);
            process.stdout.write('[stop] restored Windows system proxy\n');
        } catch (error) {
            process.stderr.write(`[stop] failed to restore Windows system proxy: ${error.message}\n`);
        }
    }

    if (info.macosProxyState) {
        try {
            await restoreMacOSSystemProxy(info.macosProxyState);
            process.stdout.write('[stop] restored macOS system proxy\n');
        } catch (error) {
            process.stderr.write(`[stop] failed to restore macOS system proxy: ${error.message}\n`);
        }
    }

    clearPidInfo();
    process.stdout.write('[stop] done\n');
})().catch((error) => {
    process.stderr.write(`[stop] failed: ${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
});

