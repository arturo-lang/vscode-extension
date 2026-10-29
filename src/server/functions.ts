import { Token } from './document';
import { Binding } from './protocol';

interface Value {
    token: Token;
    text: string;
    children?: Value[];
}

/** Read balanced values, preserving blocks as data rather than executing them. */
function values(tokens: Token[], source: string): Value[] | undefined {
    const root: Value[] = [];
    const stack = [{ children: root, close: '' }];
    for (const token of tokens) {
        if (token.kind === 'comment') continue;
        const text = source.slice(token.start, token.end);
        if (token.kind === 'close') {
            if (stack.length === 1 || stack[stack.length - 1].close !== text) return;
            stack.pop();
        } else {
            const value: Value = { token, text };
            stack[stack.length - 1].children.push(value);
            if (token.kind === 'open') {
                value.children = [];
                stack.push({ children: value.children, close: text === '[' ? ']' : ')' });
            }
        }
    }
    return stack.length === 1 ? root : undefined;
}

const title = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);
const numeric = new Set(['Integer', 'Floating']);

/** Infer only complete, simple expressions whose operand types are known. */
function resultType(body: Value[], args: Record<string, string[]>, depth = 0): string[] {
    if (depth > 32 || body.length > 256) return ['Unknown'];
    let index = 0;
    const arithmetic = (left: string[], right: string[]): string[] => {
        if (![...left, ...right].every(type => numeric.has(type))) return ['Unknown'];
        return [...new Set(left.flatMap(a => right.map(b =>
            a === 'Floating' || b === 'Floating' ? 'Floating' : 'Integer')))];
    };
    const atom = (): string[] => {
        const value = body[index++];
        if (!value) return ['Unknown'];
        if (value.text === '(') return resultType(value.children!, args, depth + 1);
        if (value.text === '[') return ['Block'];
        if (value.token.kind === 'string') return [value.text.startsWith('{/') ? 'Regex' : 'String'];
        if (value.token.kind === 'type') return ['Type'];
        if (value.token.kind === 'literal') return ['Literal'];
        if (value.token.kind === 'value') {
            if (value.text.startsWith("'")) return ['Char'];
            if (/^(?:0[xob][0-9a-fA-F]+|[0-9]+)$/.test(value.text)) return ['Integer'];
            if (/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value.text)) return ['Floating'];
        }
        if (value.token.kind === 'word') {
            if (Object.prototype.hasOwnProperty.call(args, value.text)) return args[value.text];
            if (['true', 'false', 'maybe'].includes(value.text)) return ['Logical'];
            if (value.text === 'null') return ['Null'];
            if (['add', 'sub', 'mul'].includes(value.text)) return arithmetic(expression(), expression());
        }
        return ['Unknown'];
    };
    // Arturo infix expressions associate right to left, without numeric precedence.
    const expression = (): string[] => {
        const left = atom();
        if (['+', '-', '*'].includes(body[index]?.text)) {
            index++;
            return arithmetic(left, expression());
        }
        return left;
    };
    if (body[0]?.text === 'return' && body[0].token.kind === 'word') index++;
    if (!body.length) return ['Nothing'];
    const result = expression();
    return index === body.length ? result : ['Unknown'];
}

/** Recognize the literal function and $ constructors without running source. */
export function sourceFunction(tokens: Token[], source: string, name: string): Binding | undefined {
    if (!['$', 'function'].includes(source.slice(tokens[0]?.start, tokens[0]?.end))) return;
    // Only read the constructor's two values; following statements belong to the caller.
    let end = 1;
    for (let argument = 0; argument < 2; argument++) {
        if (!tokens[end]) return;
        if (tokens[end].kind === 'open') {
            let depth = 0;
            do {
                if (tokens[end]?.kind === 'open') depth++;
                if (tokens[end]?.kind === 'close') depth--;
                end++;
            } while (depth > 0 && end < tokens.length);
            if (depth) return;
        } else end++;
    }
    const parts = values(tokens.slice(1, end), source);
    if (!parts || parts.length !== 2 || parts[1].text !== '[') return;
    const parameters = parts[0].text === '[' ? parts[0].children
        : parts[0].token.kind === 'literal' ? [parts[0]] : undefined;
    if (!parameters) return;
    const args: Record<string, string[]> = Object.create(null);
    let current: string | undefined;
    for (const parameter of parameters) {
        if (parameter.token.kind === 'word' || parameter.token.kind === 'literal') {
            current = parameter.token.name!;
            if (Object.prototype.hasOwnProperty.call(args, current)) return;
            args[current] = [];
        } else if (parameter.token.kind === 'type' && current) {
            args[current].push(title(parameter.token.name!));
        } else return;
    }
    for (const parameter of Object.keys(args)) if (!args[parameter].length) args[parameter] = ['Any'];
    return { name, kind: 'function', args, returns: resultType(parts[1].children!, args) };
}
