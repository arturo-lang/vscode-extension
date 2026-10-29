import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItem, CompletionItemKind, Hover, Location, MarkupKind, Position, Range } from 'vscode-languageserver/node';
import { Structure, tokenAt } from './document';
import { Binding, Snapshot } from './protocol';
import { RuntimeSession } from './session';

export async function loadCatalog(): Promise<Snapshot> {
    return JSON.parse(await fs.readFile(path.resolve(__dirname, '../../resources/builtins.json'), 'utf8')) as Snapshot;
}
const escaped = (value: string) => value.replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&');
function description(binding: Binding, evidence: string): string {
    const signature = binding.args ? `${binding.name} ${Object.entries(binding.args)
        .map(([name, types]) => `${name} (${types.join(', ')})`).join(' ')}` : binding.name;
    const attributes = Object.entries(binding.attrs ?? {}).map(([name, attr]) =>
        `.${name} (${attr.types.join(', ')})${attr.description ? `: ${attr.description}` : ''}`);
    return `${escaped(signature)}\n\nObserved/documented kind: ${escaped(binding.kind)}.`
        + (binding.description ? `\n\n${escaped(binding.description)}` : '')
        + (attributes.length ? `\n\nAttributes:\n${attributes.map(a => `\n- ${escaped(a)}`).join('')}` : '')
        + (binding.returns ? `\n\nReported returns: ${escaped(binding.returns.join(', '))}.` : '')
        + `\n\n${escaped(evidence)}`;
}

export function completions(document: TextDocument, structure: Structure, position: Position,
    session: RuntimeSession | undefined, catalog: Snapshot): CompletionItem[] {
    const offset = document.offsetAt(position), token = tokenAt(structure, offset);
    if (token && (token.kind === 'string' || token.kind === 'comment') && offset < token.end) return [];
    if (token && ['path', 'attribute', 'type', 'value'].includes(token.kind) && offset <= token.end) return [];
    const editable = token?.name && ['word', 'symbol', 'literal'].includes(token.kind) && token.start <= offset && token.end >= offset;
    if (token?.kind === 'label' && offset <= token.end) return [];
    const prefix = editable
        ? document.getText().slice(token.start + (document.getText()[token.start] === "'" ? 1 : 0), offset).replace(/:$/, '') : '';
    const result = new Map<string, CompletionItem>();
    const add = (binding: Binding, evidence: string, priority: string) => {
        if (result.has(binding.name) || !binding.name.startsWith(prefix)) return;
        const start = editable ? token!.start + (document.getText()[token!.start] === "'" ? 1 : 0) : offset;
        result.set(binding.name, {
            label: binding.name, kind: binding.kind === 'function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
            detail: evidence, sortText: priority + binding.name,
            documentation: { kind: MarkupKind.Markdown, value: description(binding, evidence) },
            textEdit: { range: Range.create(document.positionAt(start), document.positionAt(editable ? token!.end : offset)), newText: binding.name },
        });
    };
    for (const binding of session?.observation?.snapshot.bindings ?? []) add(binding, session!.evidence!, '0');
    for (const label of structure.labels) add({ name: label.name!, kind: 'unknown' },
        'Source label candidate; may be data or never executed', '1');
    for (const binding of catalog.bindings) add(binding,
        `Default library documentation, Arturo ${catalog.runtimeVersion}; runtime binding may differ`, '2');
    return [...result.values()];
}

export function hover(document: TextDocument, structure: Structure, position: Position,
    session: RuntimeSession | undefined, catalog: Snapshot): Hover | null {
    const token = tokenAt(structure, document.offsetAt(position));
    if (!token?.name || !['word', 'symbol', 'literal', 'label'].includes(token.kind)) return null;
    const observed = session?.observation?.snapshot.bindings.find(b => b.name === token.name);
    const candidates = structure.labels.filter(label => label.name === token.name);
    const builtin = catalog.bindings.find(b => b.name === token.name);
    const parts: string[] = [];
    if (observed) parts.push(description(observed, session!.evidence!));
    if (candidates.length) parts.push(`Source label candidates at lines ${candidates.map(label => document.positionAt(label.start).line + 1).join(', ')}. Labels can occur in data; execution and binding are unknown.`);
    if (!observed && builtin) parts.push(description(builtin,
        `Default library documentation, Arturo ${catalog.runtimeVersion}; runtime binding may differ.`));
    if (!parts.length) return null;
    return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n---\n\n') },
        range: Range.create(document.positionAt(token.start), document.positionAt(token.end)) };
}

export async function definitions(document: TextDocument, structure: Structure, position: Position,
    session?: RuntimeSession): Promise<Location[]> {
    const token = tokenAt(structure, document.offsetAt(position));
    if (!token?.name || !['word', 'literal', 'label'].includes(token.kind)) return [];
    const result = structure.labels.filter(t => t.name === token.name).map(t => Location.create(document.uri,
        Range.create(document.positionAt(t.start), document.positionAt(t.end))));
    const observed = session?.observation?.snapshot.bindings.find(b => b.name === token.name);
    // Never guess a source location for an observed global, or open its remote documentation as code.
    if (session?.status.state === 'ready' && observed?.source && observed.line) {
        try {
            const uri = URI.parse(observed.source);
            if (uri.scheme && uri.scheme !== 'file') return result;
            const filename = uri.scheme === 'file' ? uri.fsPath : path.resolve(session.observation!.cwd, observed.source);
            if ((await fs.stat(filename)).isFile()) {
                const source = await fs.readFile(filename, 'utf8');
                if (observed.line <= source.split(/\r?\n/).length) {
                    result.push(Location.create(URI.file(filename).toString(), Range.create(observed.line - 1, 0, observed.line - 1, 0)));
                }
            }
        } catch { /* unavailable source metadata */ }
    }
    return result;
}
