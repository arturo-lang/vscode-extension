const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runRuntime, parseSnapshot } = require('../out/server/runtime');
const { RuntimeSession } = require('../out/server/session');

const executable = process.env.ARTURO || 'arturo';
const available = spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout?.startsWith('arturo 0.10.0');
(available ? describe : describe.skip)('Arturo 0.10.0 runtime adapter', () => {
    let directory;
    beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arturo-lsp-test-')); });
    afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    async function setup(code, overrides = {}) {
        const entrypoint = path.join(directory, 'main.art');
        await fs.writeFile(entrypoint, code);
        return { executable, entrypoint, cwd: directory, timeoutMs: 5000, args: [], ...overrides };
    }
    test('reflects globals, rebinding, typed parameters, and excludes helpers and uncalled locals', async () => {
        const settings = await setup(`x: 42\nf: function [n :integer][local: n]\nif true [conditional: "yes"]\nprint: 99\nsymbols: 1\ninfo: 2\nkeys: 3\nloop: 4\nwrite: 5\nset: 6\ndo: 7`);
        const result = await runRuntime(settings, new AbortController().signal);
        const bindings = result.snapshot.bindings;
        expect(bindings.find(b => b.name === 'x').kind).toBe('integer');
        expect(bindings.find(b => b.name === 'print').kind).toBe('integer');
        expect(bindings.find(b => b.name === 'conditional').kind).toBe('string');
        expect(bindings.find(b => b.name === 'f').args).toEqual({ n: ['Integer'] });
        expect(bindings.some(b => b.name === 'local' || b.name.startsWith('arturoLsp'))).toBe(false);
        expect(JSON.stringify(bindings)).not.toContain('0x');
    });
    test('loads imported globals and preserves relative loads and arguments, with documented harness context', async () => {
        await fs.writeFile(path.join(directory, 'neighbor.art'), 'imported: 9');
        const settings = await setup(`do relative "neighbor.art"\nprint args\nprint standalone?\nprint script`, { args: ['hello', '--name:world'] });
        const result = await runRuntime(settings, new AbortController().signal);
        expect(result.snapshot.bindings.find(b => b.name === 'imported').kind).toBe('integer');
        expect(result.output).toContain('name:world');
        expect(result.output).toContain('hello');
        expect(result.output).toContain('false\n[]');
    });
    test('paths containing spaces, pipes, quotes, and Unicode stay data', async () => {
        if (process.platform === 'win32') return; // Windows forbids pipes and quotes in file names.
        const settings = await setup('x: 1');
        const entrypoint = path.join(directory, 'space | " λ.art');
        await fs.rename(settings.entrypoint, entrypoint);
        const result = await runRuntime({ ...settings, entrypoint }, new AbortController().signal);
        expect(result.snapshot.bindings.find(b => b.name === 'x').kind).toBe('integer');
    });
    test('reflection does not invoke custom printers and stdin requests fail without hanging', async () => {
        const settings = await setup('define :thing [\nstring: method [][print "PRINTER CALLED" return "value"]\n]\nobj: to :thing []!');
        const result = await runRuntime(settings, new AbortController().signal);
        expect(result.snapshot.bindings.find(binding => binding.name === 'obj').kind).toBe('object');
        expect(result.output).not.toContain('PRINTER CALLED');
        await expect(runRuntime(await setup('print input "Prompt: "', { timeoutMs: 1000 }), new AbortController().signal))
            .rejects.toThrow();
    });
    test('runtime error and early exit never produce a successful partial snapshot', async () => {
        for (const code of ['x: 1\nmissingWord', 'x: 1\nexit']) {
            const settings = await setup(code);
            await expect(runRuntime(settings, new AbortController().signal)).rejects.toThrow();
        }
    });
    test('timeout and explicit cancellation stop an execution', async () => {
        const settings = await setup('while [true][]', { timeoutMs: 150 });
        await expect(runRuntime(settings, new AbortController().signal)).rejects.toThrow('timed out');
        const controller = new AbortController();
        const promise = runRuntime({ ...settings, timeoutMs: 5000 }, controller.signal);
        setTimeout(() => controller.abort(), 150);
        await expect(promise).rejects.toThrow('cancelled');
    });
    test('oversized stdout is stopped and metadata is bounded', async () => {
        const settings = await setup('loop 20000 \'i [print repeat "x" 1000]');
        await expect(runRuntime(settings, new AbortController().signal)).rejects.toThrow('output exceeds');
        const metadata = await setup('f: function [n][\n;; description: {' + 'x'.repeat(11 * 1024 * 1024) + '}\n n\n]');
        await expect(runRuntime(metadata, new AbortController().signal)).rejects.toThrow('metadata exceeds');
    }, 15000);
    test('stale observations survive failure; superseded runs cannot publish', async () => {
        const notifications = [];
        const session = new RuntimeSession('file:///test', state => notifications.push(state), () => {});
        const settings = await setup('x: 1');
        await session.refresh(settings, false);
        expect(session.status.state).toBe('ready');
        session.invalidate('Edited file');
        expect(session.evidence).toContain('STALE');
        const firstObservation = session.observation;
        await session.refresh(await setup('missing'), false);
        expect(session.observation).toBe(firstObservation);
        expect(session.status.state).toBe('failed');
        const slow = await setup('while [true][]');
        const first = session.refresh(slow, false);
        await new Promise(resolve => setTimeout(resolve, 100));
        const second = await setup('newGlobal: 2', { entrypoint: path.join(directory, 'second.art') });
        await fs.writeFile(second.entrypoint, 'newGlobal: 2');
        await session.refresh(second, true);
        await first;
        expect(session.status.state).toBe('stale');
        expect(session.observation.snapshot.bindings.some(b => b.name === 'newGlobal')).toBe(true);
        expect(notifications.some(state => state.state === 'running')).toBe(true);
    });
});

test('malformed snapshot schemas are rejected', () => {
    for (const raw of ['oops', '{}', '{"schemaVersion":1,"runtimeVersion":"0.10.0","bindings":{"x":{}}}']) {
        expect(() => parseSnapshot(raw, 'helper')).toThrow();
    }
});
test('missing executables and unsupported versions fail visibly', async () => {
    const settings = { executable: '/missing-arturo-lsp-executable', cwd: os.tmpdir(), entrypoint: '', args: [], timeoutMs: 1000 };
    await expect(runRuntime(settings, new AbortController().signal)).rejects.toThrow('Cannot start Arturo');
    await expect(runRuntime({ ...settings, executable: process.execPath }, new AbortController().signal)).rejects.toThrow('Unsupported Arturo version');
});
