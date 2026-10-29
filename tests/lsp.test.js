const { describe, test, expect } = require('bun:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { URI } = require('vscode-uri');

// A bare JSON-RPC client: this test never loads VS Code or the language client.
async function client(folders, trusted, settings, capabilities = { workspace: { configuration: true, workspaceFolders: true } }) {
    const child = spawn('node', [path.resolve('out/server/main.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0), id = 0, errors = '';
    const pending = new Map(), notifications = [];

    const send = message => {
        const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
        child.stdin.write(`Content-Length: ${data.length}\r\n\r\n`); child.stdin.write(data);
    };

    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0) break;
            const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
            if (buffer.length < end + 4 + length) break;
            const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
            buffer = buffer.subarray(end + 4 + length);
            if (message.method === 'workspace/configuration') {
                send({ id: message.id, result: message.params.items.map(item => settings.get(item.scopeUri) ?? {}) });
            } else if (message.id !== undefined && message.method) send({ id: message.id, result: null });
            else if (message.id !== undefined) {
                const request = pending.get(message.id); pending.delete(message.id);
                if (message.error) request?.reject(new Error(message.error.message)); else request?.resolve(message.result);
            } else notifications.push(message);
        }
    });

    const request = (method, params) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(new Error(`LSP timeout: ${method}\n${errors}`)), 10000);

        pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); } }
        );

        send({ id: requestId, method, params });
    });

    const initialized = await request('initialize', { processId: process.pid, rootUri: folders[0].uri,
        workspaceFolders: folders, initializationOptions: { runtimeTrusted: trusted },
        capabilities }
    );

    send({ method: 'initialized', params: {} });
    
    return { initialized, notifications, request,
        notify: (method, params) => send({ method, params }),
        async close() {
            try { await request('shutdown', null); send({ method: 'exit' }); }
            finally { child.kill(); }
        },
    };
}

const uri = filename => URI.file(filename).toString();
const executable = process.env.ARTURO || 'arturo';
const available = spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout?.startsWith('arturo 0.10.0');

test('standard stdio source features work without trust or an installed runtime for every language ID', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arturo-lsp-wire-'));
    const folder = { uri: uri(root), name: 'workspace' };
    const rpc = await client([folder], false, new Map([[folder.uri, { executable: '/missing', entrypoint: 'main.art' }]]));

    try {
        expect(rpc.initialized.capabilities.textDocumentSync).toBe(2);
        for (const languageId of ['art', 'art-test', 'art-config']) {
            const file = uri(path.join(root, `${languageId}.art`));
            rpc.notify('textDocument/didOpen', { 
                textDocument: { uri: file, languageId, version: 1, text: '[\nx: 1\n] print' } 
            });

            const symbols = await rpc.request('textDocument/documentSymbol', { 
                textDocument: { uri: file } 
            });
            
            expect(symbols[0].name).toBe('x');
            expect(await rpc.request('textDocument/foldingRange', { 
                textDocument: { uri: file } 
            })).toHaveLength(1);
    
            const hover = await rpc.request('textDocument/hover', { 
                textDocument: { uri: file }, position: { line: 2, character: 4 } 
            });
            expect(hover.contents.value).toContain('Default library documentation');
        }
        const result = await rpc.request('workspace/executeCommand', { 
            command: 'arturo.runtime.refresh', arguments: [folder.uri] 
        });
    
        expect(result.message).toContain('trusted workspace');
        expect(rpc.notifications.some(n => n.method === 'arturo/runtimeStatus')).toBe(true);
    } finally { 
        await rpc.close(); await fs.rm(root, { recursive: true, force: true }); 
    }
});

(available ? test : test.skip)('explicit refresh, workspace isolation, freshness, dirty buffers, and cancellation over stdio', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arturo-lsp-wire-'));
    const folders = ['one', 'two'].map(name => ({ uri: uri(path.join(root, name)), name }));
    for (const folder of folders) await fs.mkdir(URI.parse(folder.uri).fsPath);
    const settings = new Map(folders.map(folder => [folder.uri, { executable, entrypoint: 'main.art', timeoutMs: 3000 }]));
    const one = path.join(root, 'one', 'main.art'), marker = path.join(root, 'one', 'ran.txt');
    await fs.writeFile(one, 'runtimeOnly: 42\nwrite "executed" "ran.txt"');
    await fs.writeFile(path.join(root, 'two', 'main.art'), 'otherWorkspace: 1');
    const rpc = await client(folders, true, settings);
    const refresh = folder => rpc.request('workspace/executeCommand', { command: 'arturo.runtime.refresh', arguments: [folder.uri] });
    
    try {
        const file = uri(one), query = { textDocument: { uri: file }, position: { line: 0, character: 0 } };
        rpc.notify('textDocument/didOpen', { textDocument: { uri: file, languageId: 'art', version: 1,
            text: await fs.readFile(one, 'utf8') } });

        await rpc.request('textDocument/completion', query);
        await expect(fs.stat(marker)).rejects.toThrow();

        expect((await refresh(folders[0])).state).toBe('ready');
        expect(await fs.readFile(marker, 'utf8')).toBe('executed');

        let hover = await rpc.request('textDocument/hover', query);

        expect(hover.contents.value).toContain('Observed globals');
        expect(hover.contents.value).not.toContain('STALE');

        await refresh(folders[1]);
        const items = await rpc.request('textDocument/completion', query);

        expect(items.some(item => item.label === 'otherWorkspace')).toBe(false);
        
        rpc.notify('textDocument/didChange', { textDocument: { uri: file, version: 2 }, contentChanges: [{ text: 'runtimeOnly' }] });
        hover = await rpc.request('textDocument/hover', query);
        
        expect(hover.contents.value).toContain('STALE');
        expect((await refresh(folders[0])).state).toBe('stale');
        
        rpc.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri(path.join(root, 'one', 'dependency.art')), type: 2 }] });
        hover = await rpc.request('textDocument/hover', query);
        
        expect(hover.contents.value).toContain('Workspace files changed');
        
        settings.set(folders[0].uri, { ...settings.get(folders[0].uri), entrypoint: 'slow.art' });
        await fs.writeFile(path.join(root, 'one', 'slow.art'), 'while [true][]');
        const slow = refresh(folders[0]);
        await new Promise(resolve => setTimeout(resolve, 150));
        const cancelled = await rpc.request('workspace/executeCommand', { command: 'arturo.runtime.cancel', arguments: [folders[0].uri] });

        expect(cancelled.state).toBe('cancelled');
        await slow;
    } finally { await rpc.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 15000);

test('a minimal LSP client needs no configuration or workspace-folder capabilities', async () => {
    const rpc = await client([{ uri: uri(os.tmpdir()), name: 'tmp' }], false, new Map(), {});
    try {
        const file = uri(path.join(os.tmpdir(), 'minimal.art'));
        rpc.notify('textDocument/didOpen', { textDocument: { uri: file, languageId: 'art', version: 1, text: 'print' } });
        const result = await rpc.request('textDocument/hover', { textDocument: { uri: file }, position: { line: 0, character: 2 } });
        expect(result.contents.value).toContain('Default library documentation');
    } finally { await rpc.close(); }
});

(available ? test : test.skip)('runtime diagnostics require a saved source location and clear after an edit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arturo-lsp-diagnostic-'));
    const folder = { uri: uri(root), name: 'workspace' }, file = uri(path.join(root, 'main.art'));
    const source = 'print "before"\nmissingWord\n';
    await fs.writeFile(path.join(root, 'main.art'), source);
    const rpc = await client([folder], true, new Map([[folder.uri, { executable, entrypoint: 'main.art' }]]));
    try {
        rpc.notify('textDocument/didOpen', { textDocument: { uri: file, languageId: 'art', version: 1, text: source } });
        const result = await rpc.request('workspace/executeCommand', { command: 'arturo.runtime.refresh', arguments: [folder.uri] });
        expect(result.state).toBe('failed');
        let published = rpc.notifications.filter(message => message.method === 'textDocument/publishDiagnostics' && message.params.uri === file);
        expect(published.at(-1).params.diagnostics.some(diagnostic => diagnostic.source === 'Arturo runtime')).toBe(true);
        rpc.notify('textDocument/didChange', { textDocument: { uri: file, version: 2 }, contentChanges: [{ text: 'print 1' }] });
        await rpc.request('textDocument/hover', { textDocument: { uri: file }, position: { line: 0, character: 2 } });
        published = rpc.notifications.filter(message => message.method === 'textDocument/publishDiagnostics' && message.params.uri === file);
        expect(published.at(-1).params.diagnostics).toEqual([]);
    } finally { await rpc.close(); await fs.rm(root, { recursive: true, force: true }); }
});
