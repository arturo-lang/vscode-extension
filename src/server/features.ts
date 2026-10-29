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
const displayKind = (binding: Binding) => binding.kind.charAt(0).toUpperCase() + binding.kind.slice(1);
function description(binding: Binding): string {
    const args = Object.entries(binding.args ?? {}).map(([name, types]) =>
        [name, ...types.map(type => `:${type.toLowerCase()}`)].join(' '));
    const value = binding.kind !== 'function' && !args.length;
    const signature = value ? `${binding.name} :${binding.kind.toLowerCase()}` : args.length
        ? `${binding.name} ${args.join(`\n${' '.repeat(binding.name.length + 1)}`)}` : binding.name;
    // A code block preserves argument alignment and Arturo type syntax in Markdown.
    const fence = '`'.repeat(Math.max(3, ...Array.from(signature.matchAll(/`+/g), match => match[0].length + 1)));
    const usage = `${fence}art\n${signature}\n${fence}`;
    const attributes = Object.entries(binding.attrs ?? {}).map(([name, attr]) =>
        `.${name} (${attr.types.join(', ')})${attr.description ? `: ${attr.description}` : ''}`);
    if (value) return usage;
    return `${usage}\n\n${escaped(displayKind(binding))}`
        + (binding.description ? `\n\n${escaped(binding.description)}` : '')
        + (attributes.length ? `\n\nAttributes:\n\n${attributes.map(a => `- ${escaped(a)}`).join('\n')}` : '')
        + (binding.returns?.length ? `\n\nReturns: ${escaped(binding.returns.join(', '))}` : '');
}

function sourceLabels(document: TextDocument, structure: Structure): Binding[] {
    const source = document.getText();
    const types = new Map<string, Set<string>>();
    for (let index = 0; index < structure.tokens.length; index++) {
        const label = structure.tokens[index];
        if (label.kind !== 'label') continue;
        let next = index + 1;
        while (structure.tokens[next]?.kind === 'comment') next++;
        const token = structure.tokens[next];
        const text = token ? source.slice(token.start, token.end) : '';
        let type = 'unknown';
        if (token?.kind === 'string' && !structure.diagnostics.some(diagnostic =>
            document.offsetAt(diagnostic.range.start) === token.start)) {
            type = text.startsWith('{/') ? 'regex' : 'string';
        } else if (token?.kind === 'value') {
            if (text.startsWith("'")) type = 'char';
            else if (/^(?:0[xob][0-9a-fA-F]+|[0-9]+)$/.test(text)) type = 'integer';
            else if (/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text)) type = 'floating';
        } else if (token?.kind === 'open' && text === '[') type = 'block';
        else if (token?.kind === 'type') type = 'type';
        else if (token?.kind === 'literal') type = 'literal';
        else if (token?.kind === 'word' && ['true', 'false', 'maybe'].includes(text)) type = 'logical';
        else if (token?.kind === 'word' && text === 'null') type = 'null';
        const candidates = types.get(label.name!) ?? new Set<string>();
        candidates.add(type);
        types.set(label.name!, candidates);
    }
    // Conflicting assignments and expressions need runtime information; do not guess.
    return [...types].map(([name, candidates]) => ({
        name, kind: candidates.size === 1 ? [...candidates][0] : 'unknown',
    }));
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
    const add = (binding: Binding, priority: string) => {
        if (result.has(binding.name) || !binding.name.startsWith(prefix)) return;
        const start = editable ? token!.start + (document.getText()[token!.start] === "'" ? 1 : 0) : offset;
        result.set(binding.name, {
            label: binding.name, kind: binding.kind === 'function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
            detail: displayKind(binding), sortText: priority + binding.name,
            documentation: { kind: MarkupKind.Markdown, value: description(binding) },
            textEdit: { range: Range.create(document.positionAt(start), document.positionAt(editable ? token!.end : offset)), newText: binding.name },
        });
    };
    for (const binding of session?.observation?.snapshot.bindings ?? []) add(binding, '0');
    for (const binding of sourceLabels(document, structure)) add(binding, '1');
    for (const binding of catalog.bindings) add(binding, '2');
    return [...result.values()];
}

export function hover(document: TextDocument, structure: Structure, position: Position,
    session: RuntimeSession | undefined, catalog: Snapshot): Hover | null {
    const token = tokenAt(structure, document.offsetAt(position));
    if (!token?.name || !['word', 'symbol', 'literal', 'label'].includes(token.kind)) return null;
    const observed = session?.observation?.snapshot.bindings.find(b => b.name === token.name);
    const builtin = catalog.bindings.find(b => b.name === token.name);
    const binding = observed ?? builtin ?? sourceLabels(document, structure).find(b => b.name === token.name);
    if (!binding) return null;
    return { contents: { kind: MarkupKind.Markdown, value: description(binding) },
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
