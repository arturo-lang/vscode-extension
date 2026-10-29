const { describe, test, expect } = require('bun:test');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { analyze } = require('../out/server/document');
const { completions, hover } = require('../out/server/features');
const catalog = require('../resources/builtins.json');

function example(definition, session) {
    const doc = TextDocument.create('file:///workspace/main.art', 'art', 1, `${definition}\ndouble`);
    const structure = analyze(doc);
    const position = doc.positionAt(doc.getText().length);
    return {
        hover: hover(doc, structure, position, session, catalog),
        declaration: hover(doc, structure, { line: 0, character: 2 }, session, catalog),
        completion: completions(doc, structure, position, session, catalog).find(item => item.label === 'double'),
    };
}

describe('source function signatures', () => {
    test('typed dollar function exposes parameters and inferred return on declaration, usage, and completion', () => {
        const result = example('double: $[x :integer][ x * 2 ]');
        expect(result.hover.contents.value).toBe('```art\ndouble x :integer\n```\n\nFunction\n\nReturns: Integer');
        expect(result.declaration.contents).toEqual(result.hover.contents);
        expect(result.completion.kind).toBe(3); // CompletionItemKind.Function
        expect(result.completion.detail).toBe('Function');
        expect(result.completion.documentation).toEqual(result.hover.contents);
    });

    test('function constructor, literal parameter, untyped parameters, and multiple accepted types', () => {
        for (const [definition, signature, returns] of [
            ['double: function [x :integer y :floating][x * y]', 'double x :integer\n       y :floating', 'Floating'],
            ["double: function 'x [x]", 'double x :any', 'Any'],
            ['double: $[x y][x * y]', 'double x :any\n       y :any', 'Unknown'],
            ['double: $[x :integer :floating][x * 2]', 'double x :integer :floating', 'Integer, Floating'],
            ['double: $[][42]', 'double', 'Integer'],
            ['double: $[][]', 'double', 'Nothing'],
        ]) {
            expect(example(definition).hover.contents.value)
                .toBe(`\`\`\`art\n${signature}\n\`\`\`\n\nFunction\n\nReturns: ${returns}`);
        }
    });

    test('simple explicit returns, prefix arithmetic, grouped arithmetic, and literal results', () => {
        for (const [body, type] of [
            ['return x * 2', 'Integer'], ['mul x 2', 'Integer'], ['(x * 2) + 1', 'Integer'],
            ['"hello"', 'String'], ['true', 'Logical'], ['[x * 2]', 'Block'],
            ['x * 2.5', 'Floating'], ['unknown x', 'Unknown'],
            ['if x > 0 [return "hello"] x * 2', 'Unknown'],
            ['local: x * 2 return local', 'Unknown'], ['x *', 'Unknown'],
        ]) {
            expect(example(`double: $[x :integer][${body}]`).hover.contents.value).toEndWith(`Returns: ${type}`);
        }
    });

    test('comments and nested blocks do not break constructor matching', () => {
        const result = example('double: $ ; parameters\n[x :integer] ; body\n[ ; expression\nx * 2 ; done\n]');
        expect(result.hover.contents.value).toContain('double x :integer');
        expect(result.hover.contents.value).toEndWith('Returns: Integer');
        expect(example('double: $[][ [1 (2)] ]').hover.contents.value).toEndWith('Returns: Block');
    });

    test('malformed and incomplete constructors recover without inventing signatures', () => {
        for (const definition of [
            'double: $[x :integer]', 'double: $[x :integer][x * 2',
            'double: $[x :integer][x * 2)', 'double: $[:integer][42]',
            'double: $[x x][42]', 'double: $[x [1]][42]', 'double: $[x](42)',
        ]) {
            expect(example(definition).hover.contents.value).toBe('```art\ndouble :unknown\n```');
        }
    });

    test('conflicting definitions stay unknown and following statements do not become the body', () => {
        expect(example('double: $[x :integer][x * 2]\nother: 42').hover.contents.value).toEndWith('Returns: Integer');
        expect(example('double: $[x :integer][x * 2]\ndouble: 42').hover.contents.value)
            .toBe('```art\ndouble :unknown\n```');
    });

    test('source return inference survives runtime reflection reporting Nothing', () => {
        const session = { observation: { snapshot: { bindings: [
            { name: 'double', kind: 'function', args: { x: ['Integer'] }, returns: ['Nothing'] },
        ] } } };
        const result = example('double: $[x :integer][x * 2]', session);
        expect(result.hover.contents.value).toEndWith('Returns: Integer');
        expect(result.completion.documentation).toEqual(result.hover.contents);
    });
});


describe('labels assigned function results', () => {
    function assigned(code, name = 'answer') {
        const doc = TextDocument.create('file:///workspace/main.art', 'art', 1, `${code}\n${name}`);
        const structure = analyze(doc);
        const position = doc.positionAt(doc.getText().length);
        const result = hover(doc, structure, position, undefined, catalog);
        const completion = completions(doc, structure, position, undefined, catalog).find(item => item.label === name);
        expect(completion.documentation).toEqual(result.contents);
        return result.contents.value;
    }
    const double = 'double: $[x :integer][x * 2]';

    test('propagates a user function return to declarations, references and completions', () => {
        expect(assigned(`${double}\nanswer: double 5`)).toBe('```art\nanswer :integer\n```');
        const doc = TextDocument.create('file:///workspace/main.art', 'art', 1, `${double}\nx: double 5`);
        expect(hover(doc, analyze(doc), { line: 1, character: 0 }, undefined, catalog).contents.value)
            .toBe('```art\nx :integer\n```');
    });

    test('nested calls, named argument values, aliases, and adjacent assignments', () => {
        for (const expression of ['double double 5', '(double 5)', 'double 5 + 1']) {
            expect(assigned(`${double}\nanswer: ${expression}`)).toBe('```art\nanswer :integer\n```');
        }
        expect(assigned(`${double}\ninput: 5\nintermediate: double input\nanswer: intermediate`))
            .toBe('```art\nanswer :integer\n```');
        expect(assigned(`${double} answer: double 5 other: "hello"`)).toBe('```art\nanswer :integer\n```');
    });

    test('uses string, floating, zero-argument and multi-argument function results', () => {
        for (const [code, type] of [
            ['greet: $[]["hello"] answer: greet', 'string'],
            ['scale: $[x :integer][x * 2.5] answer: scale 5', 'floating'],
            ['times: $[x :integer y :integer][x * y] answer: times 3 4', 'integer'],
        ]) expect(assigned(code)).toBe(`\`\`\`art\nanswer :${type}\n\`\`\``);
    });

    test('unresolved calls, invalid arguments, ambiguous returns and cycles stay unknown', () => {
        for (const code of [
            `${double}\nanswer: double`, `${double}\nanswer: double "hello"`,
            `${double}\nanswer: double missing`, 'answer: missing 5',
            'f: $[x :integer :floating][x * 2] answer: f 5',
            'f: $[][unknown] answer: f', 'f: $[][] answer: f',
            'answer: other other: answer', 'answer: answer',
            `${double}\ndouble: 42\nanswer: double 5`,
            `${double}\nanswer: double 5\nanswer: "hello"`,
        ]) expect(assigned(code)).toBe('```art\nanswer :unknown\n```');
    });
});
