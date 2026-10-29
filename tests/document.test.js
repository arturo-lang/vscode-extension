const { describe, test, expect } = require('bun:test');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { analyze, outline } = require('../out/server/document');
const { completions, hover, definitions } = require('../out/server/features');
const catalog = require('../resources/builtins.json');
const document = text => TextDocument.create('file:///workspace/main.art', 'art', 1, text);

describe('structural editing', () => {
    test('completion next to a delimiter never replaces the delimiter', () => {
        const doc = document('[');
        const result = completions(doc, analyze(doc), { line: 0, character: 1 }, undefined, catalog);
        expect(result.find(item => item.label === 'print').textEdit.range.start.character).toBe(1);
    });
    test('completion replaces the complete word when invoked in its middle', () => {
        const doc = document('print');
        const result = completions(doc, analyze(doc), { line: 0, character: 3 }, undefined, catalog);
        expect(result.find(item => item.label === 'print').textEdit.range.end.character).toBe(5);
    });

    test('unknown words and apparent type/arity errors in data produce no diagnostics', () => {
        const doc = document('[lorem ipsum x: add "wrong"]\nprint\nadd 1\n2');
        expect(analyze(doc).diagnostics).toEqual([]);
        expect(outline(doc, analyze(doc))[0].detail).toContain('may be data');
    });

    test('all string forms shield embedded delimiters and labels', () => {
        const doc = document(`; ] ignored:\n#! ) ignored:\n"[ ignored:"\n{!html {nested} ] ignored:}\n{: } ] ignored: :}\n{/[a-z]{2}/im}\n«« ] ignored: »»\n« ] ignored:\n'a' '[ '++ :integer .flag .opt: user\\name: 'user\\name\n---\n] ignored:`);
        const structure = analyze(doc);
        expect(structure.diagnostics).toEqual([]);
        expect(structure.labels).toEqual([]);
        expect(structure.tokens.some(t => t.kind === 'path')).toBe(true);
    });

    test('quoted labels, blocks, inlines, and sugar are structural, never scopes', () => {
        const doc = document('"quoted": 1 [\ninner: 2 (\nunknown -> => | ! ::\n)\n]');
        const structure = analyze(doc);
        expect(structure.diagnostics).toEqual([]);
        expect(structure.labels.map(t => t.name)).toEqual(['"quoted"', 'inner']);
        expect(structure.folds).toHaveLength(2);
    });

    test('incomplete input reports only structural problems and recovers', () => {
        const structure = analyze(document('[\n"unfinished\nnext: 2 )'));
        expect(structure.diagnostics.map(d => d.message)).toEqual([
            'Unterminated string', 'Unexpected closing delimiter )', 'Missing closing delimiter ]',
        ]);
        expect(structure.labels[0].name).toBe('next');
    });

    test('UTF-16 positions remain correct after non-BMP characters and CRLF', () => {
        const doc = document('"😀" x: 1\r\n[x )');
        const structure = analyze(doc);
        expect(doc.positionAt(structure.labels[0].start)).toEqual({ line: 0, character: 5 });
        expect(structure.diagnostics[0].range.start).toEqual({ line: 1, character: 3 });
    });

    test('navigation returns every candidate, without assuming a scope or latest assignment', async () => {
        const doc = document('x: 1 [x: 2] x');
        const result = await definitions(doc, analyze(doc), { line: 0, character: 13 });
        expect(result.map(location => location.range.start.character)).toEqual([0, 6]);
    });

    test('offline completions and hover are labeled default documentation', () => {
        const doc = document('pri');
        const completion = completions(doc, analyze(doc), { line: 0, character: 3 }, undefined, catalog)
            .find(item => item.label === 'print');
        expect(completion.detail).toContain('Default library documentation');
        const print = document('print');
        expect(hover(print, analyze(print), { line: 0, character: 1 }, undefined, catalog).contents.value)
            .toContain('runtime binding may differ');
    });

    test('do not offer global names as path members or inside strings', () => {
        for (const [text, character] of [['"print"', 3], ['user\\pri', 8]]) {
            const doc = document(text);
            expect(completions(doc, analyze(doc), { line: 0, character }, undefined, catalog)).toEqual([]);
        }
    });

});
