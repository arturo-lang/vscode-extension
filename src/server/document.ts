import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity, DocumentSymbol, FoldingRange, Range, SymbolKind } from 'vscode-languageserver/node';

export type TokenKind =  'word' 
    | 'label' 
    | 'path' 
    | 'literal' 
    | 'attribute' 
    | 'type' 
    | 'value'
    | 'symbol' 
    | 'string' 
    | 'comment' 
    | 'open' 
    | 'close'
;

export interface Token { kind: TokenKind; start: number; end: number; name?: string }
export interface Structure {
    tokens: Token[];
    labels: Token[];
    diagnostics: Diagnostic[];
    folds: FoldingRange[];
}
const word = /^[a-zA-Z_][a-zA-Z_0-9]*\??/;
const operators = /^[~!@#$%^&*\-=+<>/|?\\:.]+/;

/** A value/token tree, deliberately independent of runtime arities or block meaning. */
export function analyze(document: TextDocument): Structure {
    const source = document.getText();
    const tokens: Token[] = [], labels: Token[] = [], diagnostics: Diagnostic[] = [], folds: FoldingRange[] = [];
    const stack: { char: string; start: number }[] = [];
    let i = 0;
    const range = (start: number, end: number): Range => Range.create(document.positionAt(start), document.positionAt(end));
    const error = (start: number, end: number, message: string) => diagnostics.push({
        range: range(start, end), message, severity: DiagnosticSeverity.Error, source: 'Arturo structure',
    });
    const fold = (start: number, end: number) => {
        const from = document.positionAt(start), to = document.positionAt(end);
        if (to.line > from.line) folds.push({ startLine: from.line, startCharacter: from.character,
            endLine: to.line, endCharacter: to.character });
    };
    const emit = (kind: TokenKind, start: number, name?: string) => {
        const token = { kind, start, end: i, name };
        tokens.push(token);
        if (kind === 'label') labels.push(token);
    };
    while (i < source.length) {
        const start = i, c = source[i];
        if (/\s|,/.test(c)) { i++; continue; }
        if (c === ';' || source.startsWith('#!', i)) {
            while (i < source.length && !/[\r\n]/.test(source[i])) i++;
            emit('comment', start); continue;
        }
        if (c === '"' || c === '{' || c === '«' || source.startsWith('---', i)) {
            let closed = false;
            if (source.startsWith('---', i)) { i = source.length; closed = true; }
            else if (source.startsWith('««', i)) {
                const end = source.indexOf('»»', i + 2);
                closed = end >= 0; i = closed ? end + 2 : source.length;
            } else if (c === '«') {
                while (i < source.length && !/[\r\n]/.test(source[i])) i++;
                closed = true;
            } else if (c === '"') {
                i++;
                let inCode = false;
                while (i < source.length && !/[\r\n]/.test(source[i])) {
                    if (source[i] === '"') { i++; closed = true; break; }
                    if (source[i] === '|') inCode = !inCode;
                    if (source[i] === '\\' && !inCode) i += Math.min(2, source.length - i);
                    else i++;
                }
            } else {
                i++;
                if (source[i] === '!') { i++; while (/[a-zA-Z]/.test(source[i] ?? '')) i++; }
                const verbatim = source[i] === ':', regex = source[i] === '/';
                if (verbatim || regex) i++;
                let depth = 1;
                while (i < source.length) {
                    if (verbatim && source.startsWith(':}', i)) { i += 2; closed = true; break; }
                    if (regex && source[i] === '\\' && source[i + 1] === '/') { i += 2; continue; }
                    if (regex && /^\/[ims]*}/.test(source.slice(i))) {
                        i += /^\/[ims]*}/.exec(source.slice(i))![0].length; closed = true; break;
                    }
                    if (source[i] === '{') depth++;
                    if (!verbatim && source[i] === '}' && --depth === 0) { i++; closed = true; break; }
                    i++;
                }
            }
            if (!closed) error(start, Math.min(start + 1, source.length), 'Unterminated string');
            const end = i;
            // Quoted labels are valid too. Do not decode arbitrary string content into identifiers.
            if (closed && source[i] === ':') { i++; emit('label', start, source.slice(start, end)); }
            else emit('string', start);
            fold(start, end); continue;
        }
        if (c === '[' || c === '(') { i++; stack.push({ char: c, start }); emit('open', start); continue; }
        if (c === ']' || c === ')') {
            i++; const expected = c === ']' ? '[' : '(';
            if (stack[stack.length - 1]?.char === expected) { fold(stack.pop()!.start, start); }
            else error(start, i, `Unexpected closing delimiter ${c}`);
            emit('close', start); continue;
        }
        if (c === '}') { i++; error(start, i, 'Unexpected closing delimiter }'); emit('close', start); continue; }
        // A character literal is distinct from a quoted word or quoted symbol.
        if (c === "'") {
            const char = /^'(?:\\(?:x[0-9a-fA-F]{1,2}|[^\r\n])|[^'\\\r\n])'/u.exec(source.slice(i));
            if (char) { i += char[0].length; emit('value', start); continue; }
        }
        const prefix = c === "'" || c === '.' || c === ':' || c === '\\' ? c : '';
        const match = word.exec(source.slice(i + prefix.length));
        if (match) {
            i += prefix.length + match[0].length;
            let kind: TokenKind = prefix === "'" ? 'literal' : prefix === '.' ? 'attribute'
                : prefix === ':' ? 'type' : prefix === '\\' ? 'path' : 'word';
            let name = match[0];
            while (source[i] === '\\') {
                const part = /^(?:[a-zA-Z_][a-zA-Z_0-9]*\??|[0-9]+)/.exec(source.slice(i + 1));
                kind = prefix === "'" ? 'literal' : 'path';
                if (!part) break;
                i += 1 + part[0].length; name = source.slice(start, i);
            }
            if (source[i] === ':' && !source.startsWith('::', i)) {
                i++; if (kind === 'word') kind = 'label';
            }
            emit(kind, start, name); continue;
        }
        if (/[0-9]/.test(c)) {
            const number = /^(?:0[xob][0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)*(?:[eE][+-]?[0-9]+)?(?::[0-9]+)?)/.exec(source.slice(i))!;
            i += number[0].length;
            if (source[i] === '`') { i++; while (/[a-zA-Z0-9./]/.test(source[i] ?? '')) i++; }
            emit('value', start); continue;
        }
        if (c === '`') { i++; while (/[a-zA-Z0-9./]/.test(source[i] ?? '')) i++; emit('value', start); continue; }
        if (c === "'") i++;
        const operator = operators.exec(source.slice(i));
        i += operator ? operator[0].length : (source.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
        i = Math.min(i, source.length);
        emit(c === "'" ? 'literal' : 'symbol', start, source.slice(start + (c === "'" ? 1 : 0), i));
    }
    for (const open of stack) error(open.start, open.start + 1, `Missing closing delimiter ${open.char === '[' ? ']' : ')'}`);
    return { tokens, labels, diagnostics, folds };
}

export function tokenAt(structure: Structure, offset: number): Token | undefined {
    return structure.tokens.find(t => t.start <= offset && t.end > offset)
        ?? structure.tokens.find(t => t.end === offset);
}

export function outline(document: TextDocument, structure: Structure): DocumentSymbol[] {
    return structure.labels.map(label => ({
        name: label.name!, detail: 'Source label candidate; may be data or never executed', kind: SymbolKind.Variable,
        range: Range.create(document.positionAt(label.start), document.positionAt(label.end)),
        selectionRange: Range.create(document.positionAt(label.start), document.positionAt(label.end)),
    }));
}
