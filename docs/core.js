/** Glassbox compiler. No parser generators, compiler frameworks, or runtime dependencies. */
export class CompileError extends Error {
  constructor(message, phase, span) { super(message); this.name = 'CompileError'; this.phase = phase; this.span = span; }
}
export class ExecutionError extends Error {
  constructor(message, code, span) { super(message); this.name = 'ExecutionError'; this.code = code; this.span = span; }
}
const RESERVED = new Set(['fn', 'let', 'if', 'else', 'while', 'return', 'true', 'false', 'i32', 'bool']);
const MAX_SOURCE = 65536;
const MAX_DEPTH = 80;
const merge = (a, b) => ({ start: a.start, end: b.end, line: a.line, column: a.column, endLine: b.endLine, endColumn: b.endColumn });
const fail = (message, phase, span) => { throw new CompileError(message, phase, span); };

export function tokenize(source) {
  if (typeof source !== 'string') throw new TypeError('Source must be a string.');
  if (source.length > MAX_SOURCE) fail('Source is limited to 65,536 characters.', 'lexer', { start: 0, end: 1, line: 1, column: 1, endLine: 1, endColumn: 2 });
  const tokens = []; let at = 0, line = 1, column = 1;
  const advance = () => { const c = source[at++]; if (c === '\n') { line++; column = 1; } else column++; return c; };
  while (at < source.length) {
    if (/\s/.test(source[at])) { advance(); continue; }
    if (source.slice(at, at + 2) === '//') { while (at < source.length && source[at] !== '\n') advance(); continue; }
    const start = { start: at, line, column };
    if (source.slice(at, at + 2) === '/*') {
      advance(); advance();
      while (at < source.length && source.slice(at, at + 2) !== '*/') advance();
      if (at === source.length) fail('Unclosed block comment.', 'lexer', { ...start, end: at, endLine: line, endColumn: column });
      advance(); advance(); continue;
    }
    let kind, value = '';
    if (/[A-Za-z_]/.test(source[at])) {
      kind = 'identifier'; while (at < source.length && /[A-Za-z0-9_]/.test(source[at])) value += advance();
    } else if (/[0-9]/.test(source[at])) {
      kind = 'number'; while (at < source.length && /[0-9]/.test(source[at])) value += advance();
    } else {
      kind = 'symbol'; const pair = source.slice(at, at + 2);
      if (['->', '<=', '>=', '==', '!=', '&&', '||'].includes(pair)) { value = advance() + advance(); }
      else if ('(){}:;,+-*/%<>=!'.includes(source[at])) value = advance();
      else { const bad = advance(); fail(`Unexpected character ${JSON.stringify(bad)}.`, 'lexer', { ...start, end: at, endLine: line, endColumn: column }); }
    }
    tokens.push({ kind, value, span: { ...start, end: at, endLine: line, endColumn: column } });
    if (tokens.length > 16000) fail('Program has too many tokens (maximum 16,000).', 'lexer', tokens.at(-1).span);
  }
  tokens.push({ kind: 'eof', value: '<eof>', span: { start: at, end: at, line, column, endLine: line, endColumn: column } });
  return tokens;
}

const PRECEDENCE = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
export function parse(tokens) {
  let at = 0, depth = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const is = value => peek().value === value;
  const accept = value => is(value) ? take() : null;
  const expect = value => { if (!is(value)) fail(`Expected “${value}”, found “${peek().value}”.`, 'parser', peek().span); return take(); };
  const identifier = () => { const t = peek(); if (t.kind !== 'identifier' || RESERVED.has(t.value)) fail('Expected an identifier.', 'parser', t.span); return take(); };
  const type = () => { const t = take(); if (!['i32', 'bool'].includes(t.value)) fail('Expected type i32 or bool.', 'parser', t.span); return t.value; };
  const nested = fn => { if (++depth > MAX_DEPTH) fail('Syntax nesting exceeds the limit of 80.', 'parser', peek().span); try { return fn(); } finally { depth--; } };
  function expression(min = 1) { return nested(() => {
    let left;
    const t = peek();
    if (accept('-') || accept('!')) { const argument = expression(7); left = { kind: 'Unary', operator: t.value, argument, span: merge(t.span, argument.span) }; }
    else if (accept('(')) { left = expression(); expect(')'); }
    else if (t.kind === 'number') { take(); const value = Number(t.value); if (!Number.isSafeInteger(value) || value > 2147483648) fail('Integer literal is outside the i32 range.', 'parser', t.span); left = { kind: 'Literal', value, type: 'i32', span: t.span }; }
    else if (is('true') || is('false')) { take(); left = { kind: 'Literal', value: t.value === 'true', type: 'bool', span: t.span }; }
    else {
      const name = identifier();
      if (accept('(')) { const args = []; if (!is(')')) { do { args.push(expression()); } while (accept(',')); } const end = expect(')'); left = { kind: 'Call', name: name.value, args, span: merge(name.span, end.span) }; }
      else left = { kind: 'Variable', name: name.value, span: name.span };
    }
    while ((PRECEDENCE[peek().value] || 0) >= min) { const op = take(); const right = expression(PRECEDENCE[op.value] + 1); left = { kind: 'Binary', operator: op.value, left, right, span: merge(left.span, right.span) }; }
    return left;
  }); }
  function block() { return nested(() => {
    const start = expect('{'); const statements = [];
    while (!is('}') && peek().kind !== 'eof') statements.push(statement());
    const end = expect('}'); return { kind: 'Block', statements, span: merge(start.span, end.span) };
  }); }
  function statement() {
    const start = peek(); let node;
    if (accept('let')) { const name = identifier(); expect(':'); const declaredType = type(); expect('='); const value = expression(); const end = expect(';'); node = { kind: 'Let', name: name.value, declaredType, value, span: merge(start.span, end.span) }; }
    else if (accept('return')) { const value = expression(); const end = expect(';'); node = { kind: 'Return', value, span: merge(start.span, end.span) }; }
    else if (accept('if')) { expect('('); const condition = expression(); expect(')'); const then = block(); const otherwise = accept('else') ? block() : null; node = { kind: 'If', condition, then, otherwise, span: merge(start.span, (otherwise || then).span) }; }
    else if (accept('while')) { expect('('); const condition = expression(); expect(')'); const body = block(); node = { kind: 'While', condition, body, span: merge(start.span, body.span) }; }
    else { const name = identifier(); expect('='); const value = expression(); const end = expect(';'); node = { kind: 'Assign', name: name.value, value, span: merge(start.span, end.span) }; }
    return node;
  }
  const functions = [];
  while (peek().kind !== 'eof') {
    const start = expect('fn'); const name = identifier(); expect('('); const params = [];
    if (!is(')')) { do { const p = identifier(); expect(':'); const declaredType = type(); params.push({ name: p.value, type: declaredType, span: p.span }); } while (accept(',')); }
    expect(')'); expect('->'); const result = type(); const body = block();
    functions.push({ kind: 'Function', name: name.value, params, result, body, span: merge(start.span, body.span) });
    if (functions.length > 128) fail('At most 128 functions are supported.', 'parser', name.span);
  }
  return { kind: 'Program', functions, span: functions.length ? merge(functions[0].span, functions.at(-1).span) : peek().span };
}

// The typed, structured IR resolves names to numbered local/function slots.
// It preserves if/while structure; it is deliberately not SSA.
export function lower(ast) {
  const signatures = new Map();
  ast.functions.forEach((fn, index) => { if (signatures.has(fn.name)) fail(`Duplicate function “${fn.name}”.`, 'type checker', fn.span); signatures.set(fn.name, { ...fn, index }); });
  const main = signatures.get('main');
  if (!main) fail('Define fn main() -> i32 (or bool) as the entry point.', 'type checker', ast.span);
  if (main.params.length) fail('main must take no arguments.', 'type checker', main.span);
  const functions = ast.functions.map(fn => {
    const locals = []; const scopes = [new Map()];
    const declare = (name, type, span, parameter = false) => { const scope = scopes.at(-1); if (scope.has(name)) fail(`“${name}” is already declared in this scope.`, 'type checker', span); if (locals.length >= 1000) fail('A function may have at most 1,000 locals including parameters.', 'type checker', span); const local = { index: locals.length, name, type, parameter }; locals.push(local); scope.set(name, local); return local; };
    const lookup = (name, span) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); fail(`Unknown variable “${name}”.`, 'type checker', span); };
    const requireType = (expr, expected, span = expr.span) => { if (expr.type !== expected) fail(`Expected ${expected}, found ${expr.type}.`, 'type checker', span); return expr; };
    fn.params.forEach(p => declare(p.name, p.type, p.span, true));
    function expr(node, nesting = 0) {
      if (nesting > MAX_DEPTH) fail('Expression nesting exceeds the limit of 80.', 'type checker', node.span);
      const child = n => expr(n, nesting + 1);
      const common = { span: node.span };
      if (node.kind === 'Literal') { if (node.type === 'i32' && node.value > 2147483647) fail('Positive i32 literals cannot exceed 2,147,483,647.', 'type checker', node.span); return { op: 'const', type: node.type, value: Number(node.value), ...common }; }
      if (node.kind === 'Variable') { const local = lookup(node.name, node.span); return { op: 'local.get', local: local.index, name: local.name, type: local.type, ...common }; }
      if (node.kind === 'Call') { const target = signatures.get(node.name); if (!target) fail(`Unknown function “${node.name}”.`, 'type checker', node.span); if (node.args.length !== target.params.length) fail(`“${node.name}” takes ${target.params.length} arguments, received ${node.args.length}.`, 'type checker', node.span); const args = node.args.map((a, i) => requireType(child(a), target.params[i].type)); return { op: 'call', function: target.index, name: node.name, args, type: target.result, ...common }; }
      if (node.kind === 'Unary') {
        if (node.operator === '-' && node.argument.kind === 'Literal' && node.argument.value === 2147483648) return { op: 'const', type: 'i32', value: -2147483648, ...common };
        const argument = requireType(child(node.argument), node.operator === '!' ? 'bool' : 'i32'); return { op: node.operator === '!' ? 'bool.not' : 'i32.neg', argument, type: argument.type, ...common };
      }
      const left = child(node.left), right = child(node.right), operator = node.operator;
      if (['&&', '||'].includes(operator)) { requireType(left, 'bool'); requireType(right, 'bool'); }
      else if (['==', '!='].includes(operator)) requireType(right, left.type);
      else { requireType(left, 'i32'); requireType(right, 'i32'); }
      return { op: 'binary', operator, left, right, type: ['+', '-', '*', '/', '%'].includes(operator) ? 'i32' : 'bool', ...common };
    }
    function body(block, newScope = true) {
      if (newScope) scopes.push(new Map());
      const statements = block.statements.map(node => {
        const common = { span: node.span };
        if (node.kind === 'Let') { const value = requireType(expr(node.value), node.declaredType); const local = declare(node.name, node.declaredType, node.span); return { op: 'local.set', local: local.index, name: local.name, declaration: true, value, ...common }; }
        if (node.kind === 'Assign') { const local = lookup(node.name, node.span); return { op: 'local.set', local: local.index, name: local.name, declaration: false, value: requireType(expr(node.value), local.type), ...common }; }
        if (node.kind === 'Return') return { op: 'return', value: requireType(expr(node.value), fn.result), ...common };
        if (node.kind === 'If') return { op: 'if', condition: requireType(expr(node.condition), 'bool'), then: body(node.then), otherwise: node.otherwise ? body(node.otherwise) : [], ...common };
        return { op: 'while', condition: requireType(expr(node.condition), 'bool'), body: body(node.body), ...common };
      });
      if (newScope) scopes.pop();
      return statements;
    }
    const statements = body(fn.body, false);
    if (!alwaysReturns(statements)) fail(`Function “${fn.name}” must return a ${fn.result} on every path.`, 'type checker', fn.span);
    return { name: fn.name, params: fn.params.map(p => p.type), result: fn.result, locals, body: statements, span: fn.span };
  });
  return { kind: 'StructuredIR', functions, entry: main.index };
}
function alwaysReturns(body) { return body.some(s => s.op === 'return' || (s.op === 'if' && alwaysReturns(s.then) && alwaysReturns(s.otherwise))); }
function binary(operator, a, b, span) {
  switch (operator) {
    case '+': return (a + b) | 0;
    case '-': return (a - b) | 0;
    case '*': return Math.imul(a, b);
    case '/': if (!b) throw new ExecutionError('Integer division by zero.', 'DIV_ZERO', span); if (a === -2147483648 && b === -1) throw new ExecutionError('Signed integer division overflow.', 'DIV_OVERFLOW', span); return (a / b) | 0;
    case '%': if (!b) throw new ExecutionError('Integer remainder by zero.', 'DIV_ZERO', span); return (a % b) | 0;
    case '==': return Number(a === b); case '!=': return Number(a !== b);
    case '<': return Number(a < b); case '<=': return Number(a <= b); case '>': return Number(a > b); case '>=': return Number(a >= b);
    case '&&': return Number(Boolean(a && b)); case '||': return Number(Boolean(a || b));
    default: throw new Error(`Unknown operator ${operator}`);
  }
}

export function optimize(ir) {
  const changes = [];
  const record = (pass, detail, span) => changes.push({ pass, detail, span });
  const constant = (node, value) => ({ op: 'const', type: node.type, value, span: node.span });
  function expr(node) {
    if (node.op === 'call') return { ...node, args: node.args.map(expr) };
    if (node.op === 'bool.not' || node.op === 'i32.neg') { const argument = expr(node.argument); if (argument.op === 'const') { record('Constant folding', `Folded ${node.op} to a constant.`, node.span); return constant(node, node.op === 'bool.not' ? Number(!argument.value) : (-argument.value) | 0); } return { ...node, argument }; }
    if (node.op !== 'binary') return node;
    const left = expr(node.left);
    if (left.op === 'const' && ((node.operator === '&&' && !left.value) || (node.operator === '||' && left.value))) { record('Short-circuit simplification', 'Removed a right operand that cannot execute.', node.span); return constant(node, left.value); }
    const right = expr(node.right);
    if (left.op === 'const' && right.op === 'const') {
      try { const value = binary(node.operator, left.value, right.value, node.span); record('Constant folding', `${left.value} ${node.operator} ${right.value} → ${value}`, node.span); return constant(node, value); } catch (error) { if (!(error instanceof ExecutionError)) throw error; }
    }
    if ((['+', '-'].includes(node.operator) && right.op === 'const' && right.value === 0) || (['*', '/'].includes(node.operator) && right.op === 'const' && right.value === 1)) { record('Identity simplification', `Removed ${node.operator} ${right.value}; preserved the left operand.`, node.span); return { ...left, span: node.span }; }
    if ((node.operator === '&&' && left.op === 'const' && left.value === 1) || (node.operator === '||' && left.op === 'const' && left.value === 0)) { record('Short-circuit simplification', 'A constant left operand always selects the right operand.', node.span); return { ...right, span: node.span }; }
    return { ...node, left, right };
  }
  function body(statements) {
    const result = [];
    for (const s of statements) {
      if (alwaysReturns(result)) { record('Unreachable code', 'Removed a statement after an unconditional return.', s.span); continue; }
      if (s.op === 'return' || s.op === 'local.set') result.push({ ...s, value: expr(s.value) });
      else if (s.op === 'if') {
        const condition = expr(s.condition);
        if (condition.op === 'const') { record('Branch elimination', `Kept only the ${condition.value ? 'then' : 'else'} branch.`, s.span); result.push(...body(condition.value ? s.then : s.otherwise)); }
        else result.push({ ...s, condition, then: body(s.then), otherwise: body(s.otherwise) });
      } else {
        const condition = expr(s.condition);
        if (condition.op === 'const' && !condition.value) record('Loop elimination', 'Removed a loop whose condition is always false.', s.span);
        else result.push({ ...s, condition, body: body(s.body) });
      }
    }
    return result;
  }
  return { ir: { ...ir, functions: ir.functions.map(fn => ({ ...fn, body: body(fn.body) })) }, changes };
}

function unsigned(value) { const bytes = []; do { let b = value & 127; value >>>= 7; if (value) b |= 128; bytes.push(b); } while (value); return bytes; }
function signed(value) { const bytes = []; let more = true; value |= 0; while (more) { let b = value & 127; value >>= 7; more = !((value === 0 && !(b & 64)) || (value === -1 && (b & 64))); if (more) b |= 128; bytes.push(b); } return bytes; }
const vector = items => [...unsigned(items.length), ...items.flat()];
const section = (id, bytes) => [id, ...unsigned(bytes.length), ...bytes];
const nameBytes = name => { const bytes = [...new TextEncoder().encode(name)]; return [...unsigned(bytes.length), ...bytes]; };
const OPCODES = { '+': 0x6a, '-': 0x6b, '*': 0x6c, '/': 0x6d, '%': 0x6f, '==': 0x46, '!=': 0x47, '<': 0x48, '>': 0x4a, '<=': 0x4c, '>=': 0x4e };
export function emitWasm(ir) {
  const signatures = [], functionTypes = [];
  ir.functions.forEach(fn => { let index = signatures.indexOf(fn.params.length); if (index < 0) { index = signatures.length; signatures.push(fn.params.length); } functionTypes.push(unsigned(index)); });
  const types = vector(signatures.map(count => [0x60, ...vector(Array.from({ length: count }, () => [0x7f])), 1, 0x7f]));
  // Fuel counts function entries and loop condition checks, including the final check.
  const fuel = [0x23, 0, 0x41, 1, 0x6b, 0x24, 0, 0x23, 0, 0x41, 0, 0x48, 0x04, 0x40, 0x00, 0x0b];
  function expr(node) {
    if (node.op === 'const') return [0x41, ...signed(node.value)];
    if (node.op === 'local.get') return [0x20, ...unsigned(node.local)];
    if (node.op === 'call') return [...node.args.flatMap(expr), 0x10, ...unsigned(node.function)];
    if (node.op === 'bool.not') return [...expr(node.argument), 0x45];
    if (node.op === 'i32.neg') return [0x41, 0, ...expr(node.argument), 0x6b];
    if (node.operator === '&&') return [...expr(node.left), 0x04, 0x7f, ...expr(node.right), 0x05, 0x41, 0, 0x0b];
    if (node.operator === '||') return [...expr(node.left), 0x04, 0x7f, 0x41, 1, 0x05, ...expr(node.right), 0x0b];
    return [...expr(node.left), ...expr(node.right), OPCODES[node.operator]];
  }
  function body(statements) { return statements.flatMap(s => {
    if (s.op === 'return') return [...expr(s.value), 0x0f];
    if (s.op === 'local.set') return [...expr(s.value), 0x21, ...unsigned(s.local)];
    if (s.op === 'if') return [...expr(s.condition), 0x04, 0x40, ...body(s.then), ...(s.otherwise.length ? [0x05, ...body(s.otherwise)] : []), 0x0b];
    return [0x02, 0x40, 0x03, 0x40, ...fuel, ...expr(s.condition), 0x45, 0x0d, 1, ...body(s.body), 0x0c, 0, 0x0b, 0x0b];
  }); }
  const codes = ir.functions.map(fn => { const count = fn.locals.length - fn.params.length; const locals = count ? [1, ...unsigned(count), 0x7f] : [0]; const bytes = [...locals, ...fuel, ...body(fn.body), 0x00, 0x0b]; return [...unsigned(bytes.length), ...bytes]; });
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, types), ...section(3, vector(functionTypes)),
    ...section(6, [1, 0x7f, 1, 0x41, ...signed(100000), 0x0b]),
    ...section(7, vector([[...nameBytes('main'), 0, ...unsigned(ir.entry)], [...nameBytes('__fuel'), 3, 0]])),
    ...section(10, vector(codes))]);
}

export function compile(source, { optimized = true } = {}) {
  const tokens = tokenize(source); const ast = parse(tokens); const ir = lower(ast); const optimization = optimize(ir);
  const selectedIR = optimized ? optimization.ir : ir; const wasm = emitWasm(selectedIR);
  if (!WebAssembly.validate(wasm)) throw new Error('Internal compiler error: emitted invalid WebAssembly.');
  return { ast, ir, optimizedIr: optimization.ir, changes: optimization.changes, wasm, tokens: tokens.length - 1, resultType: ir.functions[ir.entry].result };
}
function checkBudget(fuel) { if (!Number.isInteger(fuel) || fuel < 0 || fuel > 10000000) throw new RangeError('Fuel must be an integer from 0 to 10,000,000.'); }
export function interpret(ir, { fuel = 100000, maxDepth = 256 } = {}) {
  checkBudget(fuel); let remaining = fuel, depth = 0;
  const tick = span => { if (--remaining < 0) throw new ExecutionError('Execution fuel exhausted.', 'FUEL', span); };
  function invoke(index, args, callSpan) {
    const fn = ir.functions[index]; tick(callSpan || fn.span);
    if (++depth > maxDepth) { depth--; throw new ExecutionError('Reference interpreter call-depth limit reached.', 'DEPTH', callSpan || fn.span); }
    const locals = new Int32Array(fn.locals.length); args.forEach((value, i) => { locals[i] = value; });
    function expr(node) {
      if (node.op === 'const') return node.value;
      if (node.op === 'local.get') return locals[node.local];
      if (node.op === 'call') return invoke(node.function, node.args.map(expr), node.span);
      if (node.op === 'bool.not') return Number(!expr(node.argument));
      if (node.op === 'i32.neg') return (-expr(node.argument)) | 0;
      const left = expr(node.left);
      if (node.operator === '&&' && !left) return 0;
      if (node.operator === '||' && left) return 1;
      return binary(node.operator, left, expr(node.right), node.span);
    }
    function body(statements) {
      for (const s of statements) {
        if (s.op === 'return') return { value: expr(s.value) };
        if (s.op === 'local.set') locals[s.local] = expr(s.value);
        else if (s.op === 'if') { const returned = body(expr(s.condition) ? s.then : s.otherwise); if (returned) return returned; }
        else if (s.op === 'while') { for (;;) { tick(s.span); if (!expr(s.condition)) break; const returned = body(s.body); if (returned) return returned; } }
      }
      return null;
    }
    try { const result = body(fn.body); if (!result) throw new Error('Internal interpreter error: missing return.'); return result.value; } finally { depth--; }
  }
  const value = invoke(ir.entry, []); return { value, fuelUsed: fuel - remaining };
}
export async function runWasm(bytes, { fuel = 100000 } = {}) {
  checkBudget(fuel);
  const { instance } = await WebAssembly.instantiate(bytes); instance.exports.__fuel.value = fuel;
  try { const value = instance.exports.main(); return { value, fuelUsed: fuel - instance.exports.__fuel.value }; }
  catch (error) {
    if (instance.exports.__fuel.value < 0) throw new ExecutionError('Execution fuel exhausted.', 'FUEL');
    if (error instanceof WebAssembly.RuntimeError) throw new ExecutionError(`WebAssembly trap: ${error.message}`, 'WASM_TRAP');
    throw error;
  }
}
export function formatIR(ir) {
  const lines = [];
  const expr = n => n.op === 'const' ? `${n.type}.const ${n.type === 'bool' ? Boolean(n.value) : n.value}` : n.op === 'local.get' ? `get %${n.local} (${n.name})` : n.op === 'call' ? `call @${n.name}(${n.args.map(expr).join(', ')})` : n.argument ? `${n.op}(${expr(n.argument)})` : `${n.type}.${n.operator}(${expr(n.left)}, ${expr(n.right)})`;
  function body(statements, indent) { const pad = '  '.repeat(indent); for (const s of statements) { if (s.op === 'return') lines.push(`${pad}return ${expr(s.value)}`); else if (s.op === 'local.set') lines.push(`${pad}%${s.local} (${s.name}) = ${expr(s.value)}`); else if (s.op === 'if') { lines.push(`${pad}if ${expr(s.condition)} {`); body(s.then, indent + 1); if (s.otherwise.length) { lines.push(`${pad}} else {`); body(s.otherwise, indent + 1); } lines.push(`${pad}}`); } else { lines.push(`${pad}while ${expr(s.condition)} {`); body(s.body, indent + 1); lines.push(`${pad}}`); } } }
  ir.functions.forEach(fn => { lines.push(`fn @${fn.name}(${fn.locals.filter(l => l.parameter).map(l => `%${l.index}: ${l.type}`).join(', ')}) -> ${fn.result} {`); body(fn.body, 1); lines.push('}', ''); }); return lines.join('\n').trim();
}
export function formatHex(bytes) { const rows = []; for (let i = 0; i < bytes.length; i += 16) rows.push(`${i.toString(16).padStart(4, '0')}  ${[...bytes.slice(i, i + 16)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`); return rows.join('\n'); }
