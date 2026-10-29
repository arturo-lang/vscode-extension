import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { URI } from 'vscode-uri';
import {
    createConnection, Diagnostic, DiagnosticSeverity, DidChangeConfigurationNotification,
    ProposedFeatures, TextDocuments, TextDocumentSyncKind, WorkspaceFolder,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, outline, Structure } from './document';
import { completions, definitions, hover, loadCatalog } from './features';
import { cancelCommand, refreshCommand, RuntimeSettings, statusNotification } from './protocol';
import { RuntimeSession } from './session';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const sessions = new Map<string, RuntimeSession>();
const structures = new Map<string, Structure>();
const runtimeDiagnostics = new Map<string, Diagnostic[]>();
const requests = new Map<string, number>();
const catalog = loadCatalog();
let folders: WorkspaceFolder[] = [], trusted = false, scopedConfiguration = false;
let folderEvents = false, configurationEvents = false;
let fallbackConfiguration: unknown = {}, stopping = false;

function sessionFor(uri: string) {
    return folders.filter(folder => uri === folder.uri || uri.startsWith(folder.uri.replace(/\/$/, '') + '/'))
        .sort((a, b) => b.uri.length - a.uri.length).map(folder => sessions.get(folder.uri))[0];
}
function publish(uri: string) {
    const document = documents.get(uri);
    connection.sendDiagnostics({ uri, version: document?.version,
        diagnostics: [...(structures.get(uri)?.diagnostics ?? []), ...(runtimeDiagnostics.get(uri) ?? [])] });
}
function invalidate(session: RuntimeSession, reason: string) {
    session.invalidate(reason);
    for (const uri of runtimeDiagnostics.keys()) {
        if (sessionFor(uri) === session) { runtimeDiagnostics.delete(uri); publish(uri); }
    }
}
function setFolders(next: WorkspaceFolder[]) {
    folders = next.filter(folder => URI.parse(folder.uri).scheme === 'file');
    for (const [uri, session] of sessions) if (!folders.some(folder => folder.uri === uri)) {
        session.cancel(); sessions.delete(uri);
    }
    for (const folder of folders) if (!sessions.has(folder.uri)) {
        sessions.set(folder.uri, new RuntimeSession(folder.uri,
            status => connection.sendNotification(statusNotification, status),
            output => { if (output) connection.console.log(`[${folder.name}]\n${output}`); }));
    }
}

connection.onInitialize(params => {
    trusted = params.initializationOptions?.runtimeTrusted === true;
    scopedConfiguration = params.capabilities.workspace?.configuration === true;
    folderEvents = params.capabilities.workspace?.workspaceFolders === true;
    configurationEvents = params.capabilities.workspace?.didChangeConfiguration?.dynamicRegistration === true;
    setFolders(params.workspaceFolders ?? (params.rootUri ? [{ uri: params.rootUri, name: 'workspace' }] : []));
    return { capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {}, hoverProvider: true, definitionProvider: true,
        documentSymbolProvider: true, foldingRangeProvider: true,
        executeCommandProvider: { commands: [refreshCommand, cancelCommand] },
        workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    }, serverInfo: { name: 'arturo-language-server', version: '0.1.0' } };
});
connection.onInitialized(() => {
    if (folderEvents) connection.workspace.onDidChangeWorkspaceFolders(event => setFolders([
        ...folders.filter(folder => !event.removed.some(removed => removed.uri === folder.uri)), ...event.added,
    ]));
    if (configurationEvents) void connection.client.register(DidChangeConfigurationNotification.type);
});
connection.onNotification('arturo/workspaceTrust', (params: { trusted: boolean }) => {
    trusted = params?.trusted === true;
    if (!trusted) for (const session of sessions.values()) { session.cancel(); invalidate(session, 'Workspace is not trusted'); }
});
connection.onDidChangeConfiguration(change => {
    fallbackConfiguration = change.settings;
    for (const session of sessions.values()) invalidate(session, 'Runtime configuration changed');
});
connection.onDidChangeWatchedFiles(change => {
    for (const session of new Set(change.changes.map(file => sessionFor(file.uri)))) {
        if (session) invalidate(session, 'Workspace files changed');
    }
});

documents.onDidChangeContent(event => {
    structures.set(event.document.uri, analyze(event.document));
    const session = sessionFor(event.document.uri);
    if (session) invalidate(session, 'Document content changed or opened; refresh to observe saved files');
    publish(event.document.uri);
});
documents.onDidClose(event => {
    structures.delete(event.document.uri); runtimeDiagnostics.delete(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});
documents.onDidSave(event => {
    const session = sessionFor(event.document.uri);
    if (session) invalidate(session, 'Document saved');
});

function structure(document: TextDocument): Structure { return structures.get(document.uri) ?? analyze(document); }
connection.onCompletion(async params => {
    const document = documents.get(params.textDocument.uri);
    return document ? completions(document, structure(document), params.position, sessionFor(document.uri), await catalog) : [];
});
connection.onHover(async params => {
    const document = documents.get(params.textDocument.uri);
    return document ? hover(document, structure(document), params.position, sessionFor(document.uri), await catalog) : null;
});
connection.onDefinition(params => {
    const document = documents.get(params.textDocument.uri);
    return document ? definitions(document, structure(document), params.position, sessionFor(document.uri)) : [];
});
connection.onDocumentSymbol(params => {
    const document = documents.get(params.textDocument.uri);
    return document ? outline(document, structure(document)) : [];
});
connection.onFoldingRanges(params => {
    const document = documents.get(params.textDocument.uri);
    return document ? structure(document).folds : [];
});

async function settingsFor(workspaceUri: string): Promise<RuntimeSettings> {
    const all = fallbackConfiguration as { arturo?: { runtime?: unknown } } | undefined;
    const value = scopedConfiguration ? await connection.workspace.getConfiguration({ scopeUri: workspaceUri, section: 'arturo.runtime' })
        : all?.arturo?.runtime;
    const settings = (value ?? {}) as Partial<RuntimeSettings>;
    if (typeof settings.entrypoint !== 'string' || !settings.entrypoint.trim()) throw new Error('Configure arturo.runtime.entrypoint before refreshing');
    if (settings.executable !== undefined && (typeof settings.executable !== 'string' || !settings.executable)) throw new Error('Invalid Arturo executable');
    if (settings.args !== undefined && (!Array.isArray(settings.args) || !settings.args.every(arg => typeof arg === 'string' && !arg.includes('\0')))) throw new Error('Runtime args must be an array of strings without NUL characters');
    if (settings.cwd !== undefined && typeof settings.cwd !== 'string') throw new Error('Runtime cwd must be a path string');
    const root = URI.parse(workspaceUri).fsPath;
    const cwd = path.resolve(root, settings.cwd || '.');
    const entrypoint = path.resolve(root, settings.entrypoint);
    if (!(await fs.stat(entrypoint)).isFile()) throw new Error('Entrypoint must be a saved file');
    const timeoutMs = settings.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) throw new Error('Runtime timeout must be 100–3600000 ms');
    return { executable: settings.executable ?? 'arturo', entrypoint, cwd, args: settings.args ?? [], timeoutMs };
}

connection.onExecuteCommand(async params => {
    if (params.command !== refreshCommand && params.command !== cancelCommand) return null;
    const argument = params.arguments?.[0];
    const session = typeof argument === 'string' ? sessions.get(argument)
        : sessions.size === 1 ? [...sessions.values()][0] : undefined;
    if (!session) throw new Error('Supply a workspace folder URI as the first command argument');
    const request = (requests.get(session.workspaceUri) ?? 0) + 1;
    requests.set(session.workspaceUri, request);
    if (params.command === cancelCommand) { session.cancel(); return session.status; }
    try {
        if (!trusted) throw new Error('Runtime execution requires a trusted workspace');
        const revision = session.revision;
        const settings = await settingsFor(session.workspaceUri);
        let dirty = false;
        const saved = new Map<string, string>();
        for (const document of documents.all()) if (sessionFor(document.uri) === session) {
            const disk = await fs.readFile(URI.parse(document.uri).fsPath, 'utf8').catch(() => undefined);
            if (disk !== document.getText()) dirty = true;
            else saved.set(document.uri, disk!);
        }
        if (requests.get(session.workspaceUri) !== request || stopping || !sessions.has(session.workspaceUri)) return null;
        if (!trusted || revision !== session.revision) throw new Error('Workspace changed while preparing execution; refresh again');
        for (const uri of runtimeDiagnostics.keys()) if (sessionFor(uri) === session) { runtimeDiagnostics.delete(uri); publish(uri); }
        const failure = await session.refresh(settings, dirty);
        // Runtime output is always logged. Only a reliable file/line for unchanged saved text becomes a diagnostic.
        if (failure && !dirty && revision === session.revision && session.status.state === 'failed') {
            const file = /^\s*┃ File: (.+)$/m.exec(failure.output)?.[1]?.trim();
            const line = /^\s*┃ Line: (\d+)$/m.exec(failure.output)?.[1];
            if (file && line && path.isAbsolute(file)) {
                const uri = URI.file(file).toString(), document = documents.get(uri), index = Number(line) - 1;
                if (document && saved.get(uri) === document.getText() && index >= 0 && index < document.lineCount) {
                    runtimeDiagnostics.set(uri, [{ range: { start: { line: index, character: 0 }, end: { line: index, character: 0 } },
                        severity: DiagnosticSeverity.Error, source: 'Arturo runtime',
                        message: `${failure.message}. See the Arturo Language Server output for details.` }]);
                    publish(uri);
                }
            }
        }
        return session.status;
    } catch (error) {
        if (requests.get(session.workspaceUri) === request && !stopping) session.fail(error instanceof Error ? error.message : String(error));
        return session.status;
    }
});

function shutdown() { stopping = true; for (const session of sessions.values()) session.cancel(); }
connection.onShutdown(async () => {
    stopping = true;
    await Promise.all([...sessions.values()].map(session => session.dispose()));
});
connection.onExit(shutdown);
process.on('disconnect', shutdown);
process.on('exit', shutdown);
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
documents.listen(connection);
connection.listen();
