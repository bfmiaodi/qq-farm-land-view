#!/usr/bin/env node

const { execFile } = require('node:child_process');

function isMacOS() {
    return process.platform === 'darwin';
}

function runNetworkSetup(args) {
    return new Promise((resolve, reject) => {
        execFile('networksetup', args, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || stdout || error.message));
                return;
            }
            resolve(String(stdout || ''));
        });
    });
}

function parseProxyState(output) {
    const text = String(output || '');
    const lines = text.split(/\r?\n/);
    const values = {};

    for (const line of lines) {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (!match) continue;
        values[match[1].trim()] = match[2].trim();
    }

    return {
        enabled: String(values.Enabled || '').toLowerCase() === 'yes',
        server: String(values.Server || ''),
        port: Number(values.Port || 0) || 0,
    };
}

function parseBypassDomains(output) {
    const text = String(output || '').trim();
    if (!text || /There (?:aren't|are not) any bypass domains/i.test(text)) {
        return [];
    }

    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

async function listNetworkServices() {
    if (!isMacOS()) return [];

    const output = await runNetworkSetup(['-listallnetworkservices']);
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('*') && !/^An asterisk/i.test(line));
}

async function getRegularServiceState(service) {
    const [web, secure, bypassDomains] = await Promise.all([
        runNetworkSetup(['-getwebproxy', service]),
        runNetworkSetup(['-getsecurewebproxy', service]),
        runNetworkSetup(['-getproxybypassdomains', service]),
    ]);

    return {
        service,
        web: parseProxyState(web),
        secure: parseProxyState(secure),
        bypassDomains: parseBypassDomains(bypassDomains),
    };
}

async function getSocksServiceState(service) {
    const [socks, bypassDomains] = await Promise.all([
        runNetworkSetup(['-getsocksfirewallproxy', service]),
        runNetworkSetup(['-getproxybypassdomains', service]),
    ]);

    return {
        service,
        socks: parseProxyState(socks),
        bypassDomains: parseBypassDomains(bypassDomains),
    };
}

async function setBypassDomains(service, bypassDomains) {
    const list = Array.isArray(bypassDomains) ? bypassDomains.filter(Boolean) : [];
    if (list.length === 0) {
        await runNetworkSetup(['-setproxybypassdomains', service, 'Empty']);
        return;
    }
    await runNetworkSetup(['-setproxybypassdomains', service, ...list]);
}

async function setMacOSSystemProxy(host, port, mode) {
    if (!isMacOS()) return null;

    const services = await listNetworkServices();
    const bypassDomains = ['localhost', '127.0.0.1'];

    if (mode === 'regular') {
        const previous = await Promise.all(services.map((service) => getRegularServiceState(service)));

        for (const service of services) {
            await runNetworkSetup(['-setwebproxy', service, host, String(port)]);
            await runNetworkSetup(['-setsecurewebproxy', service, host, String(port)]);
            await runNetworkSetup(['-setwebproxystate', service, 'on']);
            await runNetworkSetup(['-setsecurewebproxystate', service, 'on']);
            await setBypassDomains(service, bypassDomains);
        }

        return {
            platform: 'darwin',
            mode,
            previous,
        };
    }

    if (mode === 'socks5') {
        const previous = await Promise.all(services.map((service) => getSocksServiceState(service)));

        for (const service of services) {
            await runNetworkSetup(['-setsocksfirewallproxy', service, host, String(port)]);
            await runNetworkSetup(['-setsocksfirewallproxystate', service, 'on']);
            await setBypassDomains(service, bypassDomains);
        }

        return {
            platform: 'darwin',
            mode,
            previous,
        };
    }

    return null;
}

async function restoreMacOSSystemProxy(savedState) {
    if (!isMacOS() || !savedState) return;

    const mode = String(savedState.mode || '').trim().toLowerCase();
    const previous = Array.isArray(savedState.previous) ? savedState.previous : [];

    if (mode === 'regular') {
        for (const item of previous) {
            const service = item.service;
            if (item.web && item.web.enabled) {
                await runNetworkSetup(['-setwebproxy', service, item.web.server || '', String(item.web.port || 0)]);
                await runNetworkSetup(['-setwebproxystate', service, 'on']);
            } else {
                await runNetworkSetup(['-setwebproxystate', service, 'off']);
            }

            if (item.secure && item.secure.enabled) {
                await runNetworkSetup(['-setsecurewebproxy', service, item.secure.server || '', String(item.secure.port || 0)]);
                await runNetworkSetup(['-setsecurewebproxystate', service, 'on']);
            } else {
                await runNetworkSetup(['-setsecurewebproxystate', service, 'off']);
            }

            await setBypassDomains(service, item.bypassDomains || []);
        }
        return;
    }

    if (mode === 'socks5') {
        for (const item of previous) {
            const service = item.service;
            if (item.socks && item.socks.enabled) {
                await runNetworkSetup(['-setsocksfirewallproxy', service, item.socks.server || '', String(item.socks.port || 0)]);
                await runNetworkSetup(['-setsocksfirewallproxystate', service, 'on']);
            } else {
                await runNetworkSetup(['-setsocksfirewallproxystate', service, 'off']);
            }

            await setBypassDomains(service, item.bypassDomains || []);
        }
    }
}

async function disableMacOSSystemProxy() {
    if (!isMacOS()) return;

    const services = await listNetworkServices();
    for (const service of services) {
        await runNetworkSetup(['-setwebproxystate', service, 'off']).catch(() => {});
        await runNetworkSetup(['-setsecurewebproxystate', service, 'off']).catch(() => {});
        await runNetworkSetup(['-setsocksfirewallproxystate', service, 'off']).catch(() => {});
    }
}

module.exports = {
    isMacOS,
    listNetworkServices,
    setMacOSSystemProxy,
    restoreMacOSSystemProxy,
    disableMacOSSystemProxy,
};
