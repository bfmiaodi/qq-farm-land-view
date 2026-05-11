const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, dialog } = require('electron');

let backendProc = null;
let mainWindow = null;
let stopping = false;
let backendLogFile = '';

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getBackendLogFile() {
    const logDir = path.join(app.getPath('userData'), 'logs');
    ensureDir(logDir);
    return path.join(logDir, 'desktop-backend.log');
}

function appendBackendLog(prefix, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (!backendLogFile) {
        backendLogFile = getBackendLogFile();
    }
    fs.appendFileSync(backendLogFile, `${prefix}${text}`, 'utf8');
}

function readRecentBackendLog(limit = 4000) {
    if (!backendLogFile || !fs.existsSync(backendLogFile)) return '';
    const text = fs.readFileSync(backendLogFile, 'utf8');
    if (text.length <= limit) return text;
    return text.slice(text.length - limit);
}

function resolveBackendRoot() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'runtime-app');
    }
    return path.resolve(__dirname, '..');
}

function buildBackendEnv() {
    const appRoot = resolveBackendRoot();
    const packagedAppRoot = app.getAppPath();
    const dataRoot = app.getPath('userData');
    const mitmdumpPath = app.isPackaged
        ? path.join(process.resourcesPath, 'bin', 'mitmdump.exe')
        : 'mitmdump';
    const processCwd = app.isPackaged ? dataRoot : appRoot;
    const mitmAddonPath = app.isPackaged
        ? path.join(process.resourcesPath, 'runtime-app', 'src', 'mitmproxy-qqfarm-addon.py')
        : path.join(appRoot, 'src', 'mitmproxy-qqfarm-addon.py');
    const nodePathEntries = [];

    if (app.isPackaged) {
        nodePathEntries.push(path.join(packagedAppRoot, 'node_modules'));
        nodePathEntries.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'));
    } else {
        nodePathEntries.push(path.join(appRoot, 'node_modules'));
    }

    if (process.env.NODE_PATH) {
        nodePathEntries.push(process.env.NODE_PATH);
    }

    return {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: nodePathEntries.join(path.delimiter),
        QQFARM_PACKAGED: app.isPackaged ? '1' : '0',
        QQFARM_APP_ROOT: appRoot,
        QQFARM_RESOURCE_ROOT: appRoot,
        QQFARM_DATA_ROOT: dataRoot,
        QQFARM_MITMDUMP_PATH: mitmdumpPath,
        QQFARM_MITM_ADDON_PATH: mitmAddonPath,
        QQFARM_PROCESS_CWD: processCwd,
        AUTO_OPEN_BROWSER: '0',
    };
}

function startBackend() {
    const backendEntry = path.join(resolveBackendRoot(), 'src', 'start.js');
    if (!fs.existsSync(backendEntry)) {
        throw new Error(`Backend entry not found: ${backendEntry}`);
    }
    backendLogFile = getBackendLogFile();
    fs.writeFileSync(backendLogFile, '', 'utf8');
    backendProc = spawn(process.execPath, [backendEntry], {
        cwd: app.isPackaged ? process.resourcesPath : path.dirname(backendEntry),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildBackendEnv(),
        windowsHide: true,
    });

    backendProc.stdout.on('data', (chunk) => {
        process.stdout.write(`[backend] ${chunk}`);
        appendBackendLog('[stdout] ', chunk);
    });
    backendProc.stderr.on('data', (chunk) => {
        process.stderr.write(`[backend] ${chunk}`);
        appendBackendLog('[stderr] ', chunk);
    });
    backendProc.on('exit', (code, signal) => {
        const suffix = signal ? `signal=${signal}` : `code=${code}`;
        process.stderr.write(`[backend] exited ${suffix}\n`);
        appendBackendLog('[exit] ', `${suffix}\n`);
    });
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

async function waitForBackendReady(timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const health = await getJson('http://127.0.0.1:18088/healthz');
        if (health.ok && health.status >= 200 && health.status < 300) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const recentLog = readRecentBackendLog();
    throw new Error(`Backend did not become ready on http://127.0.0.1:18088/healthz\n\nRecent backend log:\n${recentLog || '(empty)'}`);
}

async function stopBackend() {
    if (stopping) return;
    stopping = true;

    const stopEntry = path.join(resolveBackendRoot(), 'src', 'stop.js');
    if (!fs.existsSync(stopEntry)) return;
    await new Promise((resolve) => {
        const stopper = spawn(process.execPath, [stopEntry], {
            cwd: app.isPackaged ? process.resourcesPath : path.dirname(stopEntry),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildBackendEnv(),
            windowsHide: true,
        });

        stopper.stdout.on('data', (chunk) => process.stdout.write(`[backend-stop] ${chunk}`));
        stopper.stderr.on('data', (chunk) => process.stderr.write(`[backend-stop] ${chunk}`));
        stopper.on('exit', () => resolve());
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1100,
        minHeight: 760,
        autoHideMenuBar: true,
        backgroundColor: '#efe7d5',
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
        },
    });

    mainWindow.loadURL('http://127.0.0.1:18088/');
}

app.whenReady().then(async () => {
    try {
        startBackend();
        await waitForBackendReady();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    } catch (error) {
        dialog.showErrorBox('QQ Farm Monitor', error && error.stack ? error.stack : String(error));
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', (event) => {
    if (stopping) return;
    event.preventDefault();
    stopBackend().finally(() => app.exit(0));
});

process.on('uncaughtException', (error) => {
    dialog.showErrorBox('QQ Farm Monitor', error && error.stack ? error.stack : String(error));
});
