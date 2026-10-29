const { describe, test, expect } = require('bun:test');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { analyze, outline } = require('../out/server/document');
const { completions, hover, definitions } = require('../out/server/features');
const { RuntimeSession } = require('../out/server/session');
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

    test('offline completions and hover show concise documentation', () => {
        const doc = document('pri');
        const completion = completions(doc, analyze(doc), { line: 0, character: 3 }, undefined, catalog)
            .find(item => item.label === 'print');
        expect(completion.detail).toBe('Function');
        const print = document('print');
        const documentation = hover(print, analyze(print), { line: 0, character: 1 }, undefined, catalog).contents;
        expect(completion.documentation).toEqual(documentation);
        expect(documentation.value).toContain('print given value to screen with newline');
        expect(documentation.value).toContain('Returns: Nothing');
        expect(documentation.value).not.toContain('Default library documentation');
        expect(documentation.value).not.toContain('runtime binding may differ');
    });

    test('do not offer global names as path members or inside strings', () => {
        for (const [text, character] of [['"print"', 3], ['user\\pri', 8]]) {
            const doc = document(text);
            expect(completions(doc, analyze(doc), { line: 0, character }, undefined, catalog)).toEqual([]);
        }
    });

});

describe('language documentation', () => {
    test('loop preserves all parameter types, attributes, and returns in hover and completion', () => {
        const doc = document('loop'), structure = analyze(doc), position = { line: 0, character: 4 };
        const expected = [
            '```art',
            'loop collection :integer :string :dictionary :object :inline :block :range',
            '     params :null :literal :block',
            '     action :block :bytecode',
            '```',
        ].join('\n') + String.raw`

Function

iterate through collection, executing given block for each item

Attributes:

- .with \(Literal\): use given index
- .forever \(Logical\): cycle through collection infinitely

Returns: Nothing`;
        const result = hover(doc, structure, position, undefined, catalog);
        expect(result.contents).toEqual({ kind: 'markdown', value: expected });
        expect(result.range).toEqual({ start: { line: 0, character: 0 }, end: position });
        const completion = completions(doc, structure, position, undefined, catalog).find(item => item.label === 'loop');
        expect(completion.detail).toBe('Function');
        expect(completion.documentation).toEqual(result.contents);
    });

    test('function matches the official parameter layout and requested documentation', () => {
        const doc = document('function'), structure = analyze(doc), position = { line: 0, character: 8 };
        const expected = [
            '```art',
            'function arguments :literal :block',
            '         body :block',
            '```',
        ].join('\n') + String.raw`

Function

create function with given arguments and body

Attributes:

- .import \(Block\): import/embed given list of symbols from current environment
- .export \(Block\): export given symbols to parent
- .memoize \(Logical\): store results of function calls
- .inline \(Logical\): execute function without scope

Returns: Function`;
        const result = hover(doc, structure, position, undefined, catalog);
        expect(result.contents.value).toBe(expected);
        expect(completions(doc, structure, position, undefined, catalog)
            .find(item => item.label === 'function').documentation).toEqual(result.contents);
    });

    test('alias follows the official layout including compound type names', () => {
        const doc = document('alias'), structure = analyze(doc), position = { line: 0, character: 5 };
        const result = hover(doc, structure, position, undefined, catalog);
        expect(result.contents.value).toStartWith([
            '```art',
            'alias symbol :string :symbol :symbolliteral :block',
            '      function :string :word :literal',
            '```',
            '',
            'Function',
        ].join('\n'));
        expect(completions(doc, structure, position, undefined, catalog)
            .find(item => item.label === 'alias').documentation).toEqual(result.contents);
    });

    test('runtime bindings override builtin and label documentation, even when stale', () => {
        const notifications = [];
        const session = new RuntimeSession('file:///workspace', state => notifications.push(state), () => {});
        session.observation = {
            snapshot: { ...catalog, bindings: [{ name: 'loop', kind: 'integer' }] },
            generation: 2, revision: 0, configuration: '{}', entrypoint: '/workspace/main.art',
            cwd: '/workspace', timestamp: '2026-10-29T02:32:52.213Z',
        };
        session.status = { workspaceUri: session.workspaceUri, generation: 2, state: 'ready' };
        const doc = document('loop: 42\nloop'), structure = analyze(doc), position = { line: 1, character: 4 };
        const ready = hover(doc, structure, position, session, catalog);
        expect(ready.contents.value).toBe('loop\n\nInteger');
        session.invalidate('Runtime configuration changed');
        expect(notifications.at(-1)).toMatchObject({ state: 'stale', staleReason: 'Runtime configuration changed' });
        expect(hover(doc, structure, position, session, catalog)).toEqual(ready);
        const completion = completions(doc, structure, position, session, catalog).find(item => item.label === 'loop');
        expect(completion.detail).toBe('Integer');
        expect(completion.documentation).toEqual(ready.contents);
        expect(completion.sortText).toBe('0loop');
    });

    test('source labels show only distinct line locations, without inferring a type', () => {
        const doc = document('local: 1 local: 2\n[local: 3]\nlocal'), structure = analyze(doc);
        const position = { line: 2, character: 5 };
        const result = hover(doc, structure, position, undefined, catalog);
        expect(result.contents.value).toBe('local\n\nSource label\n\nLines: 1, 2');
        const completion = completions(doc, structure, position, undefined, catalog).find(item => item.label === 'local');
        expect(completion.detail).toBe('Source label');
        expect(completion.documentation).toEqual(result.contents);
        expect(completion.sortText).toBe('1local');
        const single = document('local: 1');
        expect(hover(single, analyze(single), { line: 0, character: 1 }, undefined, catalog).contents.value)
            .toBe('local\n\nSource label\n\nLine: 1');
    });

    test('builtin hover omits redundant source label information', () => {
        const doc = document('loop: 1\nloop');
        const plain = document('loop');
        expect(hover(doc, analyze(doc), { line: 1, character: 1 }, undefined, catalog).contents)
            .toEqual(hover(plain, analyze(plain), { line: 0, character: 1 }, undefined, catalog).contents);
    });

    test('optional metadata is omitted and Markdown content stays escaped', () => {
        const doc = document('custom'), structure = analyze(doc), position = { line: 0, character: 3 };
        const metadata = bindings => ({ ...catalog, bindings });
        expect(hover(doc, structure, position, undefined, metadata([
            { name: 'custom', kind: 'function', args: {}, attrs: {}, returns: [] },
        ])).contents.value).toBe('```art\ncustom\n```\n\nFunction');
        const result = hover(doc, structure, position, undefined, metadata([{
            name: 'custom', kind: 'function', args: { 'arg_name': ['Block', 'String'] },
            description: '*text* [link](file) `code` <tag>',
            attrs: { 'with_index': { types: ['Literal'] } }, returns: ['Block', 'String'],
        }]));
        expect(result.contents.value).toBe('```art\ncustom arg_name :block :string\n```' + String.raw`

Function

\*text\* \[link\]\(file\) \`code\` \<tag\>

Attributes:

- .with\_index \(Literal\)

Returns: Block, String`);
        const backticks = hover(doc, structure, position, undefined, metadata([{
            name: 'custom', kind: 'function', args: { 'arg```name': ['Any'] },
        }]));
        expect(backticks.contents.value).toBe('````art\ncustom arg```name :any\n````\n\nFunction');
    });
});
