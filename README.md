# Glassbox

**A small language. A real compiler.**

Glassbox compiles a typed language into executable WebAssembly. Its browser workshop exposes the syntax tree, typed structured IR, optimized IR, actual Wasm bytes, and a source-linked transformation log. The demo compares a reference interpreter with unoptimized and optimized WebAssembly execution.

[Open the compiler workshop](https://elliottbarnes.github.io/glassbox/)

![Glassbox compiling a typed program to WebAssembly](assets/preview.png)

No dependencies, build system, compiler framework, parser generator, server API, or generated-code service. All application code is in [`docs/`](docs/), which can be served directly by GitHub Pages.

## Try it locally

Requirements: Node.js 24 or newer for tests; Python 3 or another static HTTP server for the browser demo.

```sh
npm test
npm run serve
```

Open `http://localhost:8080`. Direct `file://` browsing is unsupported because the compiler runs inside an ES module Worker. There is no `npm install` step.

Start with **Make a branch disappear**. Its unreachable division-by-zero branch disappears, its constant arithmetic folds, and all three execution paths return `42`. Switch stages to inspect the emitted artifacts. The `.wasm` download is an executable binary module, not a text representation.

Other examples cover Euclid's algorithm, recursive factorial, lazy boolean evaluation, and a deliberately endless loop stopped by the execution budget. Edit the source and press **Compile & run** or **Command/Ctrl + Enter**. Changes are temporary and are not uploaded or stored after closing the page.

## The language

```text
fn square(x: i32) -> i32 {
  return x * x + 0;
}

fn main() -> i32 {
  if (3 * 7 == 21) {
    return square(6) + (2 * 3);
  } else {
    return 1 / 0;
  }
}
```

- Every parameter, local declaration, and return type is explicitly `i32` or `bool`.
- `let` declares a mutable local. Assignment uses `=`; comparisons use `==`.
- Blocks have lexical scope. An inner declaration can shadow an outer variable; its initializer sees the outer variable. Duplicate declarations in the same scope are rejected.
- Functions can call functions declared later and can recurse. `main` must have no parameters.
- `+`, `-`, and `*` wrap with signed 32-bit semantics. `/` truncates toward zero. `%` is signed remainder. Division or remainder by zero traps; `-2147483648 / -1` traps; `-2147483648 % -1` is zero.
- Conditions require `bool`. `&&` and `||` short-circuit and `!` negates a boolean. Equality supports matching types; ordered comparisons require `i32`.
- Evaluation order is left to right, including function-call arguments.
- Every function must structurally return on every path. A final `if` qualifies only when both branches return. The checker does not prove loop termination or use constant conditions to satisfy this rule.
- Unreachable source is still parsed and type-checked before optimization.
- Line comments (`//`) and non-nesting block comments (`/* … */`) are supported. Identifiers use ASCII letters, digits, and underscores, and cannot start with a digit.

### Grammar

This grammar omits precedence tiers for readability; expressions use the conventional order listed below it.

```ebnf
program    = { function } ;
function   = "fn", identifier, "(", [parameters], ")", "->", type, block ;
parameters = parameter, { ",", parameter } ;
parameter  = identifier, ":", type ;
type       = "i32" | "bool" ;
block      = "{", { statement }, "}" ;
statement  = "let", identifier, ":", type, "=", expression, ";"
           | identifier, "=", expression, ";"
           | "return", expression, ";"
           | "if", "(", expression, ")", block, ["else", block]
           | "while", "(", expression, ")", block ;
expression = integer | "true" | "false" | identifier
           | identifier, "(", [arguments], ")"
           | "(", expression, ")"
           | ("-" | "!"), expression
           | expression, binary_operator, expression ;
arguments  = expression, { ",", expression } ;
```

Highest to lowest precedence: unary `- !`; `* / %`; `+ -`; `< <= > >=`; `== !=`; `&&`; `||`. Binary operators associate left. Parentheses override precedence. Integers are decimal, without separators or suffixes. There are no expression-only statements or `else if` shorthand; nest an `if` in an `else` block.

## Architecture

```text
source → tokens → syntax tree → type checking / name resolution
                                      ↓
                              typed structured IR
                                ↙            ↘
                       interpreter       optimizer
                                          ↓
                                  WebAssembly encoder
                                          ↓
                           browser validation + execution
```

[`docs/core.js`](docs/core.js) owns the complete pipeline:

| API | Responsibility |
| --- | --- |
| `tokenize(source)` | Recognize tokens and retain offsets, line numbers, and columns. |
| `parse(tokens)` | Recursive-descent statements and a precedence-climbing expression parser. |
| `lower(ast)` | Resolve function/local names, check types and returns, and create structured IR with numbered slots. |
| `optimize(ir)` | Produce a new IR plus a transformation log with original source spans. |
| `emitWasm(ir)` | Encode sections, signed/unsigned LEB128 integers, control flow, function calls, and locals directly into bytes. |
| `interpret(ir, options)` | Execute the IR as a separate implementation of control flow. |
| `runWasm(bytes, options)` | Instantiate the module, set its fuel budget, call `main`, and normalize runtime failures. |
| `compile(source, options)` | Run the full compiler, validate output, and return all inspectable stages. |

The IR retains structured `if` and `while` constructs. It is **not SSA** and does not implement a register allocator, general control-flow restructuring, dataflow analysis, or a native machine-code backend. Both source types use Wasm `i32`; the type checker enforces the distinction and boolean values remain canonical `0` or `1`.

Each Wasm module exports `main` and a mutable `__fuel` global. It has no imports, memory, table, host calls, or external capabilities. The backend emits type, function, global, export, and code sections. A terminal `unreachable` instruction makes the function result valid after the source checker has established that all source paths return. Structured loops use an outer block for exit and an inner loop for back edges.

### Optimizations and their limits

The optimizer walks the structured IR bottom-up and performs:

- Constant folding with signed i32 behavior.
- Arithmetic identities `x + 0`, `x - 0`, `x * 1`, and `x / 1`.
- Boolean short-circuit simplification.
- Branch elimination for constant conditions.
- Removal of constant-false loops.
- Removal of statements after an unconditional return.

It does **not** fold trapping arithmetic away, replace `x * 0` with zero, propagate mutable locals, inline functions, eliminate unused function declarations, or promise faster execution. A call or arithmetic trap in `x` must remain observable. The reference interpreter and optimizer share a primitive arithmetic helper; Wasm provides the independent arithmetic implementation used in differential checks.

The transformation log describes a single recursive simplification pass; entries are not separate whole-program passes. Byte counts include budget instrumentation and the Wasm module wrapper. Compile time is one local measurement, not a benchmark. Neither metric establishes a speedup over JavaScript or other compilers.

## Execution boundaries

The public demo compiles and runs inside a fresh dedicated Worker. A parent-page timer terminates it after three seconds. New edits or another run cancel an in-progress Worker. The compiler never evaluates source as JavaScript.

Each execution receives 100,000 fuel units. Function entry and every loop-condition check consume one, including the check that exits a loop. Arithmetic instructions do not individually consume fuel. This is a deterministic control-flow budget, not an instruction counter or wall-clock guarantee. Removing dead loops can reduce fuel use, so executions that hit a resource limit are not presented as semantic mismatches.

The reference interpreter defaults to a maximum call depth of 256; the demo uses 128. Wasm has a browser-dependent stack limit. Deep recursion can therefore stop differently across execution paths. Source is limited to 65,536 characters and 16,000 tokens; the parser/type checker limit nesting to 80, programs to 128 functions, and each function to 1,000 local slots including parameters.

The library APIs also expose fuel control (0–10,000,000). `runWasm` is synchronous while the Wasm export executes, even though instantiation is asynchronous. Applications must keep untrusted compilation/execution in a Worker or equivalent isolated job. Directly invoking the core on a main thread does not inherit the demo's termination timer.

Missing by design: arrays, strings, floats, pointers, a heap, garbage collection, modules, imports, I/O, source maps in the Wasm binary, and a debugger. Source spans are available in compile diagnostics and IR transformations; engine-generated Wasm traps are not mapped back to source. The reference interpreter usually supplies the corresponding source location.

## Validation

```sh
node --test
```

The test suite compares original IR interpretation, optimized IR interpretation, unoptimized Wasm, and optimized Wasm. It covers arithmetic boundaries and wrapping, division traps, short-circuiting, forward calls and recursion, lexical shadowing, nested loops, mutation, diagnostics and spans, optimization idempotence, source limits, execution fuel, and a seeded corpus of 250 generated arithmetic programs.

The suite verifies fuel counts between interpreter and Wasm for the same IR. It does not require equal counts between optimized and unoptimized IR. Browser verification should additionally exercise all examples, stage tabs, custom invalid source, source selection, downloaded binaries, and a narrow viewport. The UI is served without a bundler, so deployment requires only the files in `docs/`.

## Project layout

```text
docs/
  index.html   workshop interface
  style.css    responsive, reduced-motion-aware styling
  app.js       editor, stages, source links, Worker lifecycle
  worker.js    compile + execute + compare job
  core.js      compiler, interpreter, encoder, formatting helpers
test/
  compiler.test.js
```

## Learning references

- [WebAssembly binary format](https://webassembly.github.io/spec/core/binary/index.html): the module format encoded by this backend.
- [LLVM's language frontend tutorial](https://llvm.org/docs/tutorial/MyFirstLanguageFrontend/index.html): an established introduction to lexer, parser, IR, and code-generation concepts. Glassbox does not use LLVM.
- [Worker termination](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate): the browser mechanism used to stop a job that exceeds the demo's time limit.

## License

MIT. See [LICENSE](LICENSE).
