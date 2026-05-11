#!/usr/bin/env node

const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const {
    readPidInfo,
    writePidInfo,
    clearPidInfo,
    isPidAlive,
    checkPortOpen,
} = require('./process-manager');
const {
    isWindows,
    setWindowsSystemProxy,
} = require('./windows-proxy');
const {
    isMacOS,
    setMacOSSystemProxy,
} = require('./macos-proxy');

const projectRoot = path.resolve(__dirname, '..');
const mitmAddon = path.join(projectRoot, 'src', 'mitmproxy-qqfarm-addon.py');
const logServer = path.join(projectRoot, 'src', 'reqable-log-server.js');
const serverPort = Number(process.env.REQABLE_LOG_PORT || 18088);
const mitmPort = Number(process.env.MITM_PORT || 9000);
const monitorUrl = `http://127.0.0.1:${serverPort}/`;
const captureMode = String(process.env.CAPTURE_MODE || '').trim().toLowerCase() || 'mitmproxy';
const defaultMitmMode = process.platform === 'win32' ? 'regular' : 'socks5';
const mitmMode = String(process.env.MITM_PROXY_MODE || '').trim().toLowerCase() || defaultMitmMode;
const autoOpenBrowser = !['0', 'false', 'no', 'off'].includes(String(process.env.AUTO_OPEN_BROWSER || '').trim().toLowerCase());

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

function openUrl(url) {
    if (!autoOpenBrowser) return;

    if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], {
            cwd: projectRoot,
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
        }).unref();
        return;
    }

    if (process.platform === 'darwin') {
        spawn('open', [url], {
            cwd: projectRoot,
            stdio: 'ignore',
            detached: true,
        }).unref();
        return;
    }

    spawn('xdg-open', [url], {
        cwd: projectRoot,
        stdio: 'ignore',
        detached: true,
    }).unref();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(url, timeoutMs = 800) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ ok: true, status: res.statusCode || 0, data: JSON.parse(data) });
                } catch {
                    resolve({ ok: false, status: res.statusCode || 0, data: null });
                }
            });
        });
        req.on('error', () => resolve({ ok: false, status: 0, data: null }));
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            resolve({ ok: false, status: 0, data: null });
        });
    });
}

async function waitForServerReady(child, timeoutMs = 10000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (child.exitCode !== null) {
            throw new Error(`log server exited early with code=${child.exitCode}`);
        }

        const portOpen = await checkPortOpen(serverPort);
        if (portOpen) {
            const health = await getJson(`http://127.0.0.1:${serverPort}/healthz`);
            if (health.ok && health.status >= 200 && health.status < 300) {
                return;
            }
        }

        await sleep(200);
    }

    throw new Error(`log server did not become ready on 127.0.0.1:${serverPort} within ${timeoutMs}ms`);
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

    await waitForServerReady(logProc);
    let mitmProc = null;
    let windowsProxyState = null;
    let macosProxyState = null;

    if (captureMode === 'mitmproxy') {
        mitmProc = spawnProcess('mitm', 'mitmdump', [
            '--mode', mitmMode,
            '-p', String(mitmPort),
            '--ssl-insecure',
            '--set', 'connection_strategy=lazy',
            '-s', mitmAddon,
        ]);

        if (isWindows() && mitmMode === 'regular') {
            windowsProxyState = await setWindowsSystemProxy('127.0.0.1', mitmPort);
            process.stdout.write(`[main] Windows system proxy enabled: 127.0.0.1:${mitmPort}\n`);
        }

        if (isMacOS() && (mitmMode === 'regular' || mitmMode === 'socks5')) {
            macosProxyState = await setMacOSSystemProxy('127.0.0.1', mitmPort, mitmMode);
            process.stdout.write(`[main] macOS system proxy enabled (${mitmMode}): 127.0.0.1:${mitmPort}\n`);
        }
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
        windowsProxyState,
        macosProxyState,
        startedAt: new Date().toISOString(),
    });

    openUrl(monitorUrl);
    process.stdout.write(`[main] opened monitor page: ${monitorUrl}\n`);

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

