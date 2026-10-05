import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, tokenize, parse, lower, optimize, emitWasm, interpret, runWasm, CompileError, ExecutionError } from '../docs/core.js';

async function differential(source, expected, options) {
  const result = compile(source);
  const reference = interpret(result.ir, options);
  const optimizedReference = interpret(result.optimizedIr, options);
  const plain = await runWasm(emitWasm(result.ir), options);
  const optimized = await runWasm(result.wasm, options);
  for (const result of [reference, optimizedReference, plain, optimized]) assert.equal(result.value, expected);
  assert.equal(reference.fuelUsed, plain.fuelUsed);
  assert.equal(optimizedReference.fuelUsed, optimized.fuelUsed);
  return result;
}
const program = expr => `fn main() -> i32 { return ${expr}; }`;

test('arithmetic, precedence, comparisons, booleans, and signed i32 edge values agree', async () => {
  for (const [expr, expected] of [
    ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['-7 / 3', -2], ['-7 % 3', -1],
    ['2147483647 + 1', -2147483648], ['-2147483648 - 1', 2147483647],
    ['2147483647 * 2147483647', 1], ['-(-2147483648)', -2147483648],
    ['-2147483648 % -1', 0], ['0 - -1', 1], ['--12', 12]
  ]) await differential(program(expr), expected);
  await differential('fn main() -> bool { return !(2 > 3) && true || false; }', 1);
  await differential('fn main() -> bool { return true == false; }', 0);
});

test('function calls, forward references, recursion, and argument order', async () => {
  await differential('fn main() -> i32 { return fact(7); } fn fact(n: i32) -> i32 { if (n <= 1) { return 1; } else { return n * fact(n - 1); } }', 5040);
  await differential('fn sub(a: i32, b: i32) -> i32 { return a - b; } fn main() -> i32 { return sub(9, 4); }', 5);
  await differential('fn flip(a: bool) -> bool { return !a; } fn main() -> bool { return flip(false); }', 1);
});

test('loops, nested structured branches, lexical scopes, and mutation', async () => {
  await differential(`fn gcd(a: i32, b: i32) -> i32 {
    while (b != 0) { let next: i32 = a % b; a = b; b = next; } return a;
  } fn main() -> i32 { return gcd(462, 1071); }`, 21);
  await differential(`fn main() -> i32 {
    let x: i32 = 2;
    if (true) { let x: i32 = x + 8; x = x + 3; }
    return x;
  }`, 2);
  await differential(`fn main() -> i32 {
    let i: i32 = 0; let sum: i32 = 0;
    while (i < 8) { let j: i32 = 0; while (j < 4) { if (i == j) { sum = sum + 2; } else { sum = sum + 1; } j = j + 1; } i = i + 1; }
    return sum;
  }`, 36);
  await differential('fn main() -> i32 { let n: i32 = 0; while (n < 9) { if (n == 5) { return n; } n = n + 1; } return 0; }', 5);
});

test('optimizations change real generated code and preserve result', async () => {
  const source = `fn main() -> i32 { if (3 * 7 == 21) { return (40 + 2) * 1; } else { return 9 / 0; } return 66; }`;
  const result = await differential(source, 42);
  assert.ok(result.changes.some(c => c.pass === 'Branch elimination'));
  assert.ok(result.changes.some(c => c.pass === 'Unreachable code'));
  assert.ok(result.wasm.length < emitWasm(result.ir).length);
  assert.deepEqual(optimize(result.optimizedIr).ir, result.optimizedIr);
  assert.equal(optimize(result.optimizedIr).changes.length, 0);
});

test('short circuiting preserves laziness and never invents a trap', async () => {
  await differential('fn bad() -> bool { return 1 / 0 == 0; } fn main() -> bool { return false && bad(); }', 0);
  await differential('fn bad() -> bool { return 1 / 0 == 0; } fn main() -> bool { return true || bad(); }', 1);
  await differential('fn main() -> bool { let b: bool = false; return b && 1 / 0 == 0; }', 0);
  await differential('fn main() -> bool { let b: bool = true; return b || 1 / 0 == 0; }', 1);
  await differential('fn main() -> i32 { while (false) { return 1 / 0; } return 7; }', 7);
});

test('trapping arithmetic remains a runtime trap after optimization', async () => {
  for (const expr of ['1 / 0', '3 % 0', '-2147483648 / -1', '(1 / 0) * 0', '0 * (1 / 0)']) {
    const result = compile(program(expr));
    assert.throws(() => interpret(result.ir), ExecutionError);
    assert.throws(() => interpret(result.optimizedIr), ExecutionError);
    await assert.rejects(() => runWasm(result.wasm), e => e instanceof ExecutionError && e.code === 'WASM_TRAP');
    await assert.rejects(() => runWasm(emitWasm(result.ir)), e => e instanceof ExecutionError && e.code === 'WASM_TRAP');
  }
});

test('lexer/parser/type checker diagnostics carry precise source spans', () => {
  const source = 'fn main() -> i32 {\n  return true;\n}';
  assert.throws(() => compile(source), e => e instanceof CompileError && e.phase === 'type checker' && e.span.line === 2 && e.span.column === 10 && source.slice(e.span.start, e.span.end) === 'true');
  assert.throws(() => compile('fn main() -> i32 { return @; }'), e => e.phase === 'lexer' && e.span.column === 27);
  assert.throws(() => compile('fn main() -> i32 { return 1 }'), e => e.phase === 'parser' && e.message.includes('“;”'));
  assert.throws(() => compile('/* unclosed'), e => e.phase === 'lexer');
  for (const source of [
    'fn main() -> i32 { return false; }',
    'fn main() -> i32 { let x: bool = 3; return 1; }',
    'fn main() -> i32 { if (1) { return 1; } return 0; }',
    'fn main() -> i32 { return missing; }',
    'fn main() -> i32 { return missing(); }',
    'fn main() -> i32 { return true + 1; }',
    'fn main() -> bool { return 1 == false; }',
    'fn main() -> i32 { let a: i32 = 1; let a: i32 = 2; return a; }',
    'fn f(a: i32) -> i32 { return a; } fn main() -> i32 { return f(); }',
    'fn f(a: i32) -> i32 { return a; } fn main() -> i32 { return f(true); }',
    'fn main() -> i32 { if (true) { let x: i32 = 1; } return x; }',
    'fn main() -> i32 { let x: i32 = 1; x = false; return x; }',
    'fn main() -> i32 { if (true) { return 1; } }',
    'fn other() -> i32 { return 1; }',
    'fn main(a: i32) -> i32 { return a; }',
    'fn main() -> i32 { return 1; } fn main() -> i32 { return 2; }',
    'fn main() -> i32 { return 2147483648; }',
    'fn main() -> i32 { return 99999999999999999999; }'
  ]) assert.throws(() => compile(source), CompileError, source);
});

test('comments and token spans are stable across lines', () => {
  const tokens = tokenize('// hello\n/* block */ fn main() -> i32 { return 9; }');
  assert.equal(tokens[0].value, 'fn'); assert.equal(tokens[0].span.line, 2); assert.equal(tokens[0].span.column, 13);
  assert.equal(lower(parse(tokens)).functions.length, 1);
});

test('execution budgets stop loops and recursion in both backends', async () => {
  for (const source of ['fn main() -> i32 { while (true) { } return 0; }', 'fn main() -> i32 { return main(); }']) {
    const result = compile(source);
    for (const ir of [result.ir, result.optimizedIr]) {
      assert.throws(() => interpret(ir, { fuel: 30 }), e => e.code === 'FUEL');
      await assert.rejects(() => runWasm(emitWasm(ir), { fuel: 30 }), e => e.code === 'FUEL');
    }
  }
  const result = compile(program('4'));
  assert.throws(() => interpret(result.ir, { fuel: 0 }), e => e.code === 'FUEL');
  await assert.rejects(() => runWasm(result.wasm, { fuel: 0 }), e => e.code === 'FUEL');
  await differential(program('4'), 4, { fuel: 1 });
  assert.throws(() => interpret(result.ir, { fuel: -1 }), RangeError);
  await assert.rejects(() => runWasm(result.wasm, { fuel: Infinity }), RangeError);
  const recursion = compile('fn main() -> i32 { return main(); }');
  assert.throws(() => interpret(recursion.ir, { fuel: 1000, maxDepth: 20 }), e => e.code === 'DEPTH');
});

test('input limits reject oversized or deeply nested programs with diagnostics', () => {
  assert.throws(() => compile(' '.repeat(65537)), e => e instanceof CompileError && e.phase === 'lexer');
  assert.throws(() => compile(program('('.repeat(100) + '1' + ')'.repeat(100))), e => e instanceof CompileError && e.message.includes('nesting'));
  assert.throws(() => compile(program(Array.from({ length: 150 }, () => '1').join('+'))), e => e instanceof CompileError && e.message.includes('nesting'));
});

test('seeded differential arithmetic corpus covers 250 independently generated programs', async () => {
  let state = 0x13579bdf;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) | 0; return state; };
  const literal = n => n < 0 ? `(${n})` : String(n);
  for (let i = 0; i < 250; i++) {
    const a = next(), b = next(), c = next();
    const expected = ((Math.imul(a, b) + c) ^ 0);
    const source = `fn f(a: i32, b: i32) -> i32 { return a * b; } fn main() -> i32 { let x: i32 = ${literal(a)}; return f(x, ${literal(b)}) + ${literal(c)}; }`;
    await differential(source, expected);
  }
});
