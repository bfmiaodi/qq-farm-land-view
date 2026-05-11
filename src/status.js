#!/usr/bin/env node

const http = require('node:http');
const {
    readPidInfo,
    isPidAlive,
    checkPortOpen,
} = require('./process-manager');

const serverPort = Number(process.env.REQABLE_LOG_PORT || 18088);
const mitmPort = Number(process.env.MITM_PORT || 9000);

function getJson(url) {
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
        req.setTimeout(800, () => {
            req.destroy();
            resolve({ ok: false, status: 0, data: null });
        });
    });
}

(async () => {
    const pidInfo = readPidInfo();
    const serverOpen = await checkPortOpen(serverPort);
    const captureMode = String((pidInfo && pidInfo.captureMode) || process.env.CAPTURE_MODE || '').trim().toLowerCase() || 'mitmproxy';
    const mitmOpen = captureMode === 'mitmproxy' ? await checkPortOpen(mitmPort) : false;
    const health = serverOpen ? await getJson(`http://127.0.0.1:${serverPort}/healthz`) : { ok: false, status: 0, data: null };

    process.stdout.write('QQ Farm Monitor Status\n');
    process.stdout.write(`- PID file: ${pidInfo ? 'present' : 'missing'}\n`);
    process.stdout.write(`- capture mode: ${captureMode}\n`);
    if (pidInfo) {
        process.stdout.write(`- main pid: ${pidInfo.mainPid} (${isPidAlive(pidInfo.mainPid) ? 'alive' : 'dead'})\n`);
        process.stdout.write(`- server pid: ${pidInfo.serverPid} (${isPidAlive(pidInfo.serverPid) ? 'alive' : 'dead'})\n`);
        if (captureMode === 'mitmproxy') {
            process.stdout.write(`- mitm pid: ${pidInfo.mitmPid} (${isPidAlive(pidInfo.mitmPid) ? 'alive' : 'dead'})\n`);
            process.stdout.write(`- mitm mode: ${pidInfo.mitmMode || 'socks5'}\n`);
        }
        process.stdout.write(`- started at: ${pidInfo.startedAt}\n`);
    }
    process.stdout.write(`- log server port ${serverPort}: ${serverOpen ? 'listening' : 'closed'}\n`);
    if (captureMode === 'mitmproxy') {
        process.stdout.write(`- mitm port ${mitmPort}: ${mitmOpen ? 'listening' : 'closed'}\n`);
    }
    process.stdout.write(`- /healthz: ${health.ok ? `ok (HTTP ${health.status})` : 'unreachable'}\n`);
})();

