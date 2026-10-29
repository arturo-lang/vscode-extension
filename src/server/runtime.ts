import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Binding, RuntimeSettings, Snapshot } from './protocol';

export const maxBytes = 10 * 1024 * 1024;
const temporaryDirectories = new Set<string>();
// The protocol transport can exit synchronously on an abruptly closed client pipe.
process.once('exit', () => {
    for (const directory of temporaryDirectories) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort abrupt-exit cleanup */ }
    }
});
const resource = (file: string) => path.resolve(__dirname, '../../resources', file);
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
// Pipes toggle interpolation parsing even in ordinary strings. Encode them as bytes,
// and use Arturo's byte escapes rather than JSON's unsupported \uXXXX escapes.
export const arturoString = (value: string): string => JSON.stringify(value)
    .replace(/\|/g, '\\x7c').replace(/\\u00([0-9a-f]{2})/gi, '\\x$1');

/** Only reflection metadata crosses this boundary; values and addresses are discarded. */
export function normalizeBinding(name: string, value: unknown): Binding {
    if (!record(value) || typeof value.type !== 'string') throw new Error(`Invalid metadata for ${name}`);
    const binding: Binding = { name, kind: value.type.toLowerCase() };
    binding.description = text(value.description);
    binding.source = text(value.source);
    if (Number.isSafeInteger(value.line) && (value.line as number) > 0) binding.line = value.line as number;
    if (record(value.args)) {
        binding.args = Object.fromEntries(Object.entries(value.args)
            .filter(([, types]) => strings(types)).map(([key, types]) => [key, strings(types)!]));
    }
    if (record(value.attrs)) {
        binding.attrs = Object.fromEntries(Object.entries(value.attrs)
            .filter(([, attr]) => record(attr) && strings(attr.types))
            .map(([key, attr]) => [key, {
                types: strings((attr as Record<string, unknown>).types)!,
                description: text((attr as Record<string, unknown>).description),
            }]));
    }
    binding.returns = strings(value.returns);
    return binding;
}

export function parseSnapshot(raw: string, helperPrefix: string): Snapshot {
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.schemaVersion !== 1 || typeof data.runtimeVersion !== 'string'
        || !record(data.bindings)) throw new Error('Invalid Arturo snapshot schema');
    return {
        schemaVersion: 1, runtimeVersion: data.runtimeVersion,
        bindings: Object.entries(data.bindings).filter(([name]) => !name.startsWith(helperPrefix))
            .map(([name, value]) => normalizeBinding(name, value)),
    };
}

export class RuntimeFailure extends Error {
    constructor(message: string, public output = '') { super(message); }
}

/** Kill the whole execution group, including programs started by the entrypoint. */
function terminate(pid: number): void {
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } });
        return;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
}

async function execute(executable: string, args: string[], cwd: string, timeout: number,
    signal: AbortSignal, resultFile?: string): Promise<string> {
    if (signal.aborted) throw new RuntimeFailure('Runtime refresh cancelled');
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let bytes = 0;
        const chunks: Buffer[] = [];
        let failure: string | undefined;
        const stop = (reason: string) => {
            failure ??= reason;
            if (child.pid) terminate(child.pid);
        };
        const abort = () => stop('Runtime refresh cancelled');
        signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => stop(`Runtime refresh timed out after ${timeout} ms`), timeout);
        const monitor = setInterval(() => {
            if (resultFile) void fs.stat(resultFile).then(stat => {
                if (stat.size > maxBytes) stop('Runtime metadata exceeds 10 MiB');
            }, () => {});
        }, 50);
        const output = (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) stop('Runtime output exceeds 10 MiB');
            else chunks.push(chunk);
        };
        child.stdout.on('data', output);
        child.stderr.on('data', output);
        const cleanup = () => {
            clearTimeout(timer); clearInterval(monitor); signal.removeEventListener('abort', abort);
        };
        child.once('error', error => {
            cleanup(); reject(new RuntimeFailure(`Cannot start Arturo: ${error.message}`));
        });
        child.once('close', code => {
            cleanup();
            // Also stop descendants that detached from their parent while retaining its group.
            if (child.pid && process.platform !== 'win32') terminate(child.pid);
            const captured = Buffer.concat(chunks).toString('utf8');
            if (failure || code !== 0) reject(new RuntimeFailure(failure ?? `Arturo exited with code ${code}`, captured));
            else resolve(captured);
        });
        if (signal.aborted) abort();
    });
}

/** Baseline mode is reserved for regenerating the bundled builtin catalog. */
export async function runRuntime(settings: RuntimeSettings, signal: AbortSignal,
    baseline = false): Promise<{ snapshot: Snapshot; output: string }> {
    const version = await execute(settings.executable, ['--version'], settings.cwd,
        Math.min(settings.timeoutMs, 5000), signal);
    if (!/^arturo 0\.10\.0(?:\s|$)/m.test(version)) {
        throw new RuntimeFailure(`Unsupported Arturo version: ${version.trim()}. This adapter supports 0.10.0.`);
    }
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'arturo-lsp-'));
    temporaryDirectories.add(directory);
    const result = path.join(directory, 'snapshot.json');
    const harness = path.join(directory, 'runtime.art');
    const prefix = `arturoLsp${randomBytes(12).toString('hex')}X`;
    try {
        const template = await fs.readFile(resource('runtime.art'), 'utf8');
        const code = template.replace(/\blsp([A-Za-z]+)/g, (_, name: string) => `${prefix}${name}`)
            .replace('__ENTRYPOINT__', () => baseline ? '[]' : arturoString(settings.entrypoint))
            .replace('__RESULT__', () => arturoString(result));
        await fs.writeFile(harness, code, { mode: 0o600 });
        const output = await execute(settings.executable, ['--no-color', harness, ...settings.args],
            settings.cwd, settings.timeoutMs, signal, result);
        const handle = await fs.open(result, 'r').catch(() => {
            throw new RuntimeFailure('Arturo exited without producing a snapshot (possibly an early exit)', output);
        });
        let raw: string;
        try {
            if ((await handle.stat()).size > maxBytes) throw new RuntimeFailure('Runtime metadata exceeds 10 MiB', output);
            const buffer = Buffer.alloc(maxBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > maxBytes) throw new RuntimeFailure('Runtime metadata exceeds 10 MiB', output);
            raw = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
        try { return { snapshot: parseSnapshot(raw, prefix), output }; }
        catch (error) { throw new RuntimeFailure(`Cannot decode runtime snapshot: ${String(error)}`, output); }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
        temporaryDirectories.delete(directory);
    }
}
