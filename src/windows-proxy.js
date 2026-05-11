#!/usr/bin/env node

const { execFile } = require('node:child_process');

function isWindows() {
    return process.platform === 'win32';
}

function runRegistry(args) {
    return new Promise((resolve, reject) => {
        execFile('reg', args, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || stdout || error.message));
                return;
            }
            resolve(String(stdout || ''));
        });
    });
}

function runInternetSetOption() {
    return new Promise((resolve, reject) => {
        const command = [
            'Add-Type -Namespace WinInet -Name Native -MemberDefinition @\'',
            '[DllImport("wininet.dll", SetLastError = true)]',
            'public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
            '\'@;',
            '[WinInet.Native]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null;',
            '[WinInet.Native]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null;',
        ].join(' ');

        execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || stdout || error.message));
                return;
            }
            resolve();
        });
    });
}

function parseRegistryValue(output, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(output || '').match(new RegExp(`${escapedKey}\\s+REG_\\w+\\s+(.*)`));
    return match ? match[1].trim() : '';
}

async function getCurrentProxyState() {
    if (!isWindows()) return null;

    const output = await runRegistry([
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
    ]).catch(() => '');

    const serverOutput = await runRegistry([
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
    ]).catch(() => '');

    const overrideOutput = await runRegistry([
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyOverride',
    ]).catch(() => '');

    return {
        proxyEnable: parseRegistryValue(output, 'ProxyEnable') || '0',
        proxyServer: parseRegistryValue(serverOutput, 'ProxyServer') || '',
        proxyOverride: parseRegistryValue(overrideOutput, 'ProxyOverride') || '',
    };
}

async function setWindowsSystemProxy(host, port) {
    if (!isWindows()) return null;

    const previous = await getCurrentProxyState();
    const proxyServer = `${host}:${port}`;
    const proxyOverride = '<local>;127.0.0.1;localhost';

    await runRegistry([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
        '/t',
        'REG_SZ',
        '/d',
        proxyServer,
        '/f',
    ]);

    await runRegistry([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyOverride',
        '/t',
        'REG_SZ',
        '/d',
        proxyOverride,
        '/f',
    ]);

    await runRegistry([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
        '/t',
        'REG_DWORD',
        '/d',
        '1',
        '/f',
    ]);

    await runInternetSetOption();

    return {
        previous,
        current: {
            proxyEnable: '1',
            proxyServer,
            proxyOverride,
        },
    };
}

async function restoreWindowsSystemProxy(savedState) {
    if (!isWindows() || !savedState) return;

    const state = savedState.previous || savedState;
    const proxyEnable = String(state.proxyEnable || '0').trim() || '0';
    const proxyServer = String(state.proxyServer || '');
    const proxyOverride = String(state.proxyOverride || '');

    await runRegistry([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
        '/t',
        'REG_DWORD',
        '/d',
        proxyEnable,
        '/f',
    ]);

    await runRegistry([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
        '/t',
        'REG_SZ',
        '/d',
        proxyServer,
        '/f',
    ]);

    await runRegistry([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyOverride',
        '/t',
        'REG_SZ',
        '/d',
        proxyOverride,
        '/f',
    ]);

    await runInternetSetOption();
}

module.exports = {
    isWindows,
    getCurrentProxyState,
    setWindowsSystemProxy,
    restoreWindowsSystemProxy,
};
