#!/usr/bin/env node

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
    readPidInfo,
    writePidInfo,
    clearPidInfo,
    isPidAlive,
    checkPortOpen,
} = require('./process-manager');

const projectRoot = path.resolve(__dirname, '..');
const mitmAddon = path.join(projectRoot, 'src', 'mitmproxy-qqfarm-addon.py');
const logServer = path.join(projectRoot, 'src', 'reqable-log-server.js');
const serverPort = Number(process.env.REQABLE_LOG_PORT || 18088);
const mitmPort = Number(process.env.MITM_PORT || 9000);
const captureMode = String(process.env.CAPTURE_MODE || '').trim().toLowerCase() || 'mitmproxy';
const mitmMode = String(process.env.MITM_PROXY_MODE || '').trim().toLowerCase() || 'socks5';

function forwardPrefix(stream, prefix, target) {
    stream.on('data', (chunk) => {
        const text = chunk.toString();
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line && i === lines.length - 1) continue;
            target.write(`${prefix}${line}\n`);
        }
    });
}

function spawnProcess(name, cmd, args, options = {}) {
    const child = spawn(cmd, args, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env, ...(options.env || {}) },
    });

    forwardPrefix(child.stdout, `[${name}] `, process.stdout);
    forwardPrefix(child.stderr, `[${name}] `, process.stderr);
    child.on('exit', (code, signal) => {
        const suffix = signal ? `signal=${signal}` : `code=${code}`;
        process.stderr.write(`[${name}] exited ${suffix}\n`);
    });
    return child;
}

async function assertPortsAvailable() {
    const checks = [{ port: serverPort, name: 'log-server' }];
    if (captureMode === 'mitmproxy') {
        checks.push({ port: mitmPort, name: 'mitmdump' });
    }

    for (const item of checks) {
        const open = await checkPortOpen(item.port);
        if (open) {
            process.stderr.write(`[main] port ${item.port} is already in use, cannot start ${item.name}\n`);
            process.exit(1);
        }
    }
}

async function main() {
    const existing = readPidInfo();
    if (existing && isPidAlive(existing.mainPid)) {
        process.stderr.write(`[main] already running, pid=${existing.mainPid}. Run npm run stop first.\n`);
        process.exit(1);
    }
    if (existing) clearPidInfo();

    await assertPortsAvailable();

    const logProc = spawnProcess('server', process.execPath, [logServer], {
        env: {
            REQABLE_LOG_PORT: String(serverPort),
            CAPTURE_MODE: captureMode,
            MITM_PROXY_MODE: mitmMode,
        },
    });
    let mitmProc = null;

    if (captureMode === 'mitmproxy') {
        mitmProc = spawnProcess('mitm', 'mitmdump', [
            '--mode', mitmMode,
            '-p', String(mitmPort),
            '--ssl-insecure',
            '--set', 'connection_strategy=lazy',
            '-s', mitmAddon,
        ]);
    } else if (captureMode !== 'reqable') {
        process.stderr.write(`[main] unsupported CAPTURE_MODE=${captureMode}, expected mitmproxy or reqable\n`);
        if (!logProc.killed) logProc.kill('SIGINT');
        process.exit(1);
    }

    writePidInfo({
        mainPid: process.pid,
        serverPid: logProc.pid,
        mitmPid: mitmProc ? mitmProc.pid : 0,
        serverPort,
        mitmPort: captureMode === 'mitmproxy' ? mitmPort : 0,
        captureMode,
        mitmMode: captureMode === 'mitmproxy' ? mitmMode : '',
        startedAt: new Date().toISOString(),
    });

    function shutdown(signal) {
        process.stderr.write(`[main] shutting down by ${signal}\n`);
        if (!logProc.killed) logProc.kill('SIGINT');
        if (mitmProc && !mitmProc.killed) mitmProc.kill('SIGINT');
        clearPidInfo();
        setTimeout(() => process.exit(0), 300);
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
    process.stderr.write(`[main] start failed: ${error && error.stack ? error.stack : String(error)}\n`);
    clearPidInfo();
    process.exit(1);
});

