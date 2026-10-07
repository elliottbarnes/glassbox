# Glassbox reference guide

[Back to the project overview](../README.md)

**A small language. A real compiler.**

Glassbox compiles a small typed language into executable WebAssembly. Its browser workshop exposes the syntax tree, typed structured intermediate representation (IR), optimized IR, actual Wasm bytes, and a source-linked transformation log. Edit a program and compare its answer across a reference interpreter, unoptimized Wasm, and optimized Wasm.

[Open the compiler workshop](https://elliottbarnes.github.io/glassbox/)

![Glassbox compiling a typed program to WebAssembly](../assets/preview.png)

The lexer, parser, type checker, optimizer, interpreter, and binary encoder are implemented here. There are no runtime dependencies, parser generators, compiler frameworks, build tools, or backend services. All browser application code lives in [`docs/`](../docs/).

This is an educational compiler with explicit limits. It makes the path from source code to executable bytes inspectable; it does not claim production-language completeness or performance superiority over established compilers.

## Contents

- [Quick start](#quick-start)
- [Explore the workshop](#explore-the-workshop)
- [The language](#the-language)
- [Use the compiler as a library](#use-the-compiler-as-a-library)
- [Architecture](#architecture)
- [Optimizations and their limits](#optimizations-and-their-limits)
- [Execution boundaries](#execution-boundaries)
- [Validation](#validation)
- [Project layout](#project-layout)
- [Static hosting](#static-hosting)
- [Troubleshooting](#troubleshooting)
- [Contributing and extending the compiler](#contributing-and-extending-the-compiler)
- [Learning references](#learning-references)
- [License](#license)

## Quick start

You need Git to clone the project, **Node.js 24 or newer** to run tests, and **Python 3** for the included static-server command. A browser with WebAssembly, ES modules, and module Workers runs the workshop. No package installation, account, API key, environment file, or database is required.

```sh
git clone https://github.com/elliottbarnes/glassbox.git
cd glassbox
node --version
npm test
npm run serve
```

Open **http://localhost:8080**. Stop the development server with **Ctrl+C**. `npm test` runs Node's built-in test runner; `npm run serve` runs `python3 -m http.server 8080 --directory docs`. There is no `npm install` or build step.

If port 8080 is already in use, start the same files on another port:

```sh
python3 -m http.server 8081 --bind 127.0.0.1 --directory docs
```

Then open `http://localhost:8081`. Any static HTTP server that serves JavaScript modules with an appropriate JavaScript MIME type can replace Python. Opening `docs/index.html` directly with a `file://` URL is unsupported because the application loads an ES module Worker.

The npm script uses Python's default bind address. Use the explicit `--bind 127.0.0.1` form when you want a server reachable only from your own machine. This development server is for local previews.

## Explore the workshop

The initial example, **Make a branch disappear**, returns `42`. Its constant arithmetic folds, its unreachable division-by-zero branch disappears, and all three execution paths retain the same answer.

1. Choose an example or edit the source. Edits mark old results as stale.
2. Select **Compile & run**, or press **Command/Ctrl + Enter**.
3. Switch between **Syntax tree**, **Typed IR**, **Optimized**, and **Wasm** to inspect the pipeline.
4. Click a transformation-log entry to select the corresponding source text.
5. Select **Download .wasm** to save the optimized executable binary.

The Wasm stage displays **hexadecimal bytes**, not WebAssembly text format (WAT). The syntax-tree view omits spans for readability; the underlying AST and IR retain them. The optimized stage shows the project's own IR notation, not LLVM IR or Wasm instructions.

| Example | What it demonstrates | Expected result |
| --- | --- | --- |
| Make a branch disappear | Constant folding, an arithmetic identity, branch elimination, and a function call | `42` |
| Euclid's algorithm | Mutable parameters and locals, a loop, signed remainder, and function calls | `21` |
| Recursive factorial | A forward call, recursion, and a returning `if / else` | `5040` |
| Skip a trap | Boolean short-circuiting around a function that would divide by zero | `true` |
| Stop an endless loop | Fuel exhaustion without blocking the page | Execution stops at the fuel limit |

Selecting another example or **Reset example** replaces the editor contents and runs that example. Source is held in page memory; the application does not upload it or persist edits. Reloading the page restores the initial example. Save any source you want to keep before resetting or leaving.

A green agreement message means the three displayed executions completed with equal values for that program. A resource limit or runtime trap is reported separately. It is not a proof of correctness for all programs.

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

### Types, scope, and control flow

- Every parameter, local declaration, and function result is explicitly `i32` or `bool`. There are no implicit conversions.
- `let` declares a mutable local. Assignment uses `=`; equality comparison uses `==`.
- Blocks have lexical scope. Inner locals can shadow outer locals, and an inner declaration's initializer can read the outer variable. Duplicate declarations in the same scope are rejected. Parameters share the scope of the function's outermost body.
- Variables must be declared before use and initialized when declared. Function signatures are collected before bodies are checked, so forward calls and recursion work.
- `main` is the entry point, takes no arguments, and returns either supported type.
- Conditions require `bool`. Both arms of an `if` use braces; `else` is optional.
- Every function must structurally return on every path. An `if` qualifies when both branches return. The checker does not use constant conditions or prove loop termination to satisfy this rule.
- Unreachable source is still parsed and type-checked before optimization. An unreachable division by zero is a valid expression that can be removed; an unreachable type error still fails compilation.

For example, `fn main() -> i32 { if (true) { return 1; } }` is rejected. Add an `else` that returns or a subsequent `return`. An endless `while (true)` also needs a later structural return, even though execution never reaches it.

### Arithmetic and boolean semantics

| Operation | Behavior |
| --- | --- |
| `+`, `-`, `*`, unary `-` | Wrap to signed 32-bit integers. For example, `2147483647 + 1` becomes `-2147483648`. |
| `/` | Signed integer division, truncated toward zero. `-7 / 3` is `-2`. |
| `%` | Signed remainder. `-7 % 3` is `-1`. |
| `/ 0`, `% 0` | Runtime trap, unless execution cannot reach the expression. |
| `-2147483648 / -1` | Runtime trap for signed division overflow. |
| `-2147483648 % -1` | `0`; signed remainder does not have the division overflow trap. |
| `<`, `<=`, `>`, `>=` | Compare `i32` values and return `bool`. |
| `==`, `!=` | Compare values of matching types and return `bool`. |
| `&&`, `||`, `!` | Boolean operations. `&&` and `||` short-circuit their right operand. |

Evaluation is left to right, including function-call arguments. Literals are decimal; positive literals cannot exceed `2147483647`, and the unary-negative form permits `-2147483648`. There are no hexadecimal literals, separators, or suffixes. Both runtime representations use Wasm `i32`; boolean results remain canonical `0` or `1`, displayed as `false` or `true` in the workshop.

### Grammar

The grammar below describes the accepted constructs; its expression production is abbreviated rather than a parser-generation specification. Precedence is listed afterward.

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
binary_operator = "+" | "-" | "*" | "/" | "%"
                | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||" ;
integer    = digit, { digit } ;
identifier = (letter | "_"), { letter | digit | "_" } ;
letter     = "A" … "Z" | "a" … "z" ;
digit      = "0" … "9" ;
```

Highest to lowest precedence: unary `- !`; `* / %`; `+ -`; `< <= > >=`; `== !=`; `&&`; `||`. Binary operators associate left. Parentheses override precedence.

Keywords cannot be identifiers. Line comments (`//`) and non-nesting block comments (`/* … */`) are supported. There are no expression-only statements, standalone block statements, trailing commas, or `else if` shorthand; put a nested `if` inside an `else` block.

## Use the compiler as a library

The same dependency-free ES module runs in Node and in the browser. From the repository root, run this example in a POSIX shell:

```sh
node --input-type=module <<'JS'
import { compile, emitWasm, interpret, runWasm } from './docs/core.js';

const source = `
fn square(x: i32) -> i32 {
  return x * x + 0;
}
fn main() -> i32 {
  if (3 * 7 == 21) {
    return square(6) + (2 * 3);
  } else {
    return 1 / 0;
  }
}`;

const build = compile(source);
const unoptimizedBytes = emitWasm(build.ir);
const reference = interpret(build.ir);
const unoptimized = await runWasm(unoptimizedBytes);
const optimized = await runWasm(build.wasm);

console.log(JSON.stringify({
  values: [reference.value, unoptimized.value, optimized.value],
  fuelUsed: [reference.fuelUsed, unoptimized.fuelUsed, optimized.fuelUsed],
  bytes: { unoptimized: unoptimizedBytes.length, optimized: build.wasm.length },
  transformations: build.changes.length,
  validWasm: WebAssembly.validate(build.wasm)
}, null, 2));
JS
```

In another shell, save the JavaScript between the `JS` delimiters as `example.mjs` in the repository root and run `node example.mjs` instead.

Expected output with the current encoder:

```json
{
  "values": [
    42,
    42,
    42
  ],
  "fuelUsed": [
    2,
    2,
    2
  ],
  "bytes": {
    "unoptimized": 135,
    "optimized": 111
  },
  "transformations": 5,
  "validWasm": true
}
```

Two units of fuel account for entry into `main` and `square`. Byte sizes and transformation counts describe this implementation and can change as the compiler develops.

`compile(source)` returns:

| Field | Meaning |
| --- | --- |
| `ast` | Parsed syntax tree with source spans. |
| `ir` | Original typed structured IR. |
| `optimizedIr` | Simplified typed structured IR. |
| `changes` | Transformation records: `pass`, `detail`, and source `span`. |
| `wasm` | The selected executable module as a `Uint8Array`; optimized by default. |
| `tokens` | Number of source tokens, excluding the end-of-file token. |
| `resultType` | The declared return type of `main`, either `i32` or `bool`. |

Use `compile(source, { optimized: false })` to select unoptimized Wasm. Both IR forms and the transformation log are still computed and returned; this option does not bypass the optimizer. `emitWasm(build.ir)` also produces the unoptimized binary directly. `interpret(build.optimizedIr)` lets you run the optimized IR without Wasm.

Both `interpret` and `runWasm` return `{ value, fuelUsed }`. Boolean `value` is numeric `0` or `1`; use `resultType` if you want to format it as a boolean. The module also exports `formatIR(ir)` and `formatHex(bytes)` for readable inspection.

Invalid source programs raise `CompileError` with a `phase` and source `span`; passing a non-string source raises `TypeError`. Runtime failures use `ExecutionError` for recognized traps and limits. A span has zero-based, end-exclusive `start`/`end` offsets and one-based line/column coordinates; offsets and columns follow JavaScript UTF-16 code units. The interpreter reports `DIV_ZERO`, `DIV_OVERFLOW`, `FUEL`, or `DEPTH`; Wasm execution reports `FUEL` or `WASM_TRAP` for recognized runtime traps. Host validation, instantiation, or stack failures may surface as native errors instead. Trap message wording can vary between engines.

Use `compile` as the source-input boundary. The lower-level functions expect compiler-produced AST, IR, or modules; they do not validate arbitrary serialized structures. Treat returned objects as read-only. Optimization creates new structure where needed and may share unchanged nodes with the original IR.

## Architecture

```text
source → tokens → syntax tree → type checking + name resolution
                                      ↓
                              typed structured IR
                       ┌──────────────┼──────────────┐
                       ↓              ↓              ↓
                  interpreter    Wasm encoder     optimizer
                                      ↓              ↓
                              unoptimized Wasm   optimized IR
                                                     ↓
                                                Wasm encoder
                                                     ↓
                                                optimized Wasm
                       └────── compare execution results ──────┘
```

[`docs/core.js`](../docs/core.js) owns the complete language pipeline:

| Function | Responsibility |
| --- | --- |
| `tokenize(source)` | Recognize tokens while retaining offsets, line numbers, and columns. |
| `parse(tokens)` | Use recursive-descent statements and precedence-climbing expressions to build an AST. |
| `lower(ast)` | Resolve names to numbered function/local slots, enforce types and returns, and construct typed IR. |
| `optimize(ir)` | Simplify the IR and record transformations with original source spans. |
| `emitWasm(ir)` | Encode module sections, integer encodings, structured control flow, calls, and locals directly into bytes. |
| `interpret(ir, options)` | Execute the IR using a separate implementation of control flow. |
| `runWasm(bytes, options)` | Instantiate a generated module, initialize its fuel, call `main`, and report results or failures. |
| `compile(source, options)` | Run the full compiler and validate the selected binary with `WebAssembly.validate`. |

The IR retains structured `if` and `while` constructs. It is **not SSA** and does not implement register allocation, general control-flow restructuring, whole-program dataflow analysis, or a native machine-code backend. A source local maps to a numbered Wasm local; a shadowing declaration gets a distinct slot.

The encoder writes type, function, global, export, and code sections. Its `unsigned` and `signed` helpers implement LEB128, the variable-length integer encoding used by Wasm. Since both supported types use Wasm `i32`, function signatures can currently be shared by parameter count. Adding another representation would require revisiting that assumption.

Each generated module exports `main` and a mutable `__fuel` global initialized to 100,000. It has no imports, linear memory, table, heap, or host calls. Structured loops use an outer block for exit and an inner loop for back edges. A terminal `unreachable` instruction makes the function body valid after source checking has established structural returns. Boolean short-circuit operations use result-producing Wasm `if` instructions.

[`docs/worker.js`](../docs/worker.js) runs the original interpreter, original Wasm, and optimized Wasm sequentially. It catches each execution's outcome separately so a trap in one path does not hide the others. [`docs/app.js`](../docs/app.js) owns the editor, displays results, selects source spans, and creates or terminates Workers. Tests additionally interpret optimized IR, giving a fourth comparison path.

## Optimizations and their limits

The optimizer performs one recursive simplification pass. It simplifies child expressions, preserves short-circuit reachability, and rebuilds statement lists. The log's `pass` labels identify transformation categories; they are not separate whole-program passes.

| Transformation | Example | Constraint |
| --- | --- | --- |
| Constant folding | `3 * 7` → `21` | Uses signed i32 wrapping and retains expressions that would trap. |
| Arithmetic identities | `x + 0`, `x - 0`, `x * 1`, `x / 1` → `x` | The left operand still executes. These are the implemented directional forms. |
| Short-circuit simplification | `false && rhs` → `false`; `true || rhs` → `true` | Removes only an operand that cannot execute. |
| Constant boolean selection | `true && rhs` → `rhs`; `false || rhs` → `rhs` | The right operand remains evaluated. |
| Branch elimination | `if (true) { a } else { b }` → `a` | The selected branch is simplified; original code was already type-checked. |
| Loop elimination | `while (false) { body }` → nothing | No body execution is lost. Fuel use can change. |
| Unreachable statement removal | Statements after `return`, or after an `if` whose arms both return | Source diagnostics have already been checked. |

It does not propagate mutable local values, inline functions, remove unused functions or local slots, or replace `x * 0` with zero. For example, `(1 / 0) * 0` must still trap. Similarly, unused function declarations remain in the generated module even if all calls disappear.

The optimizer and reference interpreter share a primitive arithmetic helper. Wasm supplies the independent arithmetic implementation in differential comparisons. This is useful cross-checking, but shared frontend and helper code can still share defects.

Byte counts include the module wrapper and execution-budget instrumentation. The displayed compile time is a single local measurement, not a benchmark. Fewer bytes do not necessarily imply faster execution, and there is no claim of a speedup over JavaScript or other compilers.

## Execution boundaries

The browser creates a fresh dedicated Worker for each compile-and-run job. The parent page requests termination after **three seconds**; new edits or another run also cancel an in-progress Worker. The timer covers compilation and all three executions together. It is a responsiveness safeguard, not a hard real-time guarantee, since scheduling and background-tab behavior are controlled by the browser. Source is never evaluated as JavaScript.

| Boundary | Current behavior |
| --- | --- |
| Source size | At most 65,536 JavaScript UTF-16 code units. |
| Token count | At most 16,000 source tokens, excluding the end-of-file marker. |
| Functions | At most 128. |
| Local slots | At most 1,000 per function, including parameters and shadowed declarations. |
| Nesting | Guards based on 80 in the parser and typed-expression walker; they count nesting separately. |
| Execution fuel | 100,000 by default for each interpreter or Wasm execution. |
| Configurable fuel | An integer from 0 through 10,000,000 for `interpret` and `runWasm`. |
| Interpreter call depth | 256 by default in the library; 128 in the browser demo. |
| Wasm call depth | Limited by the host engine; it need not match the interpreter. |
| Browser job lifetime | Parent-page termination timer at 3,000 milliseconds. |

Function entry and **every loop-condition check** consume one fuel unit, including the check that exits a loop. Arithmetic instructions do not individually consume fuel. Fuel zero prevents even entry into `main`; one unit can run a non-calling, non-looping `main`. `fuelUsed` measures these checks, not instruction count, CPU time, or energy use.

Optimizations can remove checks, so equal programs can need different amounts of fuel before and after optimization. Deep recursion can also reach different interpreter and Wasm stack limits. A resource-limited result is therefore not automatically a semantic discrepancy.

Although `runWasm` returns a promise, the exported Wasm function executes synchronously after instantiation. Calling the library directly does not inherit the workshop's parent timer. Keep untrusted or large jobs in a Worker or equivalent isolated task. The mutable `__fuel` export is an execution aid, not a security boundary against a caller that can reset it.

Missing by design: arrays, strings, floating-point values, pointers, a heap, garbage collection, modules, imports, I/O, a debugger, and source maps embedded in the Wasm binary. Engine-generated Wasm traps do not map back to source; the reference interpreter can often provide the corresponding span.

## Validation

Run the complete automated suite from the repository root:

```sh
npm test
```

Equivalent direct invocation:

```sh
node --test
```

To check the browser modules' syntax as the repository's CI does, use this POSIX-shell command:

```sh
for file in docs/*.js; do node --check "$file"; done
```

The current suite has **11 test groups**, including a seeded corpus of **250 generated arithmetic programs**. The `differential` helper compares original IR interpretation, optimized IR interpretation, unoptimized Wasm, and optimized Wasm against expected values. It also compares fuel counts between interpreter and Wasm for the same IR.

Covered behaviors include signed arithmetic boundaries, wrapping multiplication, division/remainder traps, lazy booleans, forward calls, recursion, lexical shadowing, nested loops, assignment, diagnostics and spans, transformation results, one optimization-idempotence case, oversized/deep inputs, fuel exhaustion, and interpreter call-depth exhaustion.

These tests **do not prove** universal semantic preservation, complete grammar coverage, every numerical guard's boundary, arbitrary-IR validation, all malformed inputs, cross-browser equivalence, or a performance improvement. The generated corpus uses one arithmetic/call template with varied values; it is not a general grammar fuzzer. The suite does not drive a browser or exercise the actual parent-page Worker timeout.

For browser changes, also check all five examples, every stage tab, a custom type error, source-span selection, cancellation after editing, downloading and validating a module, and a narrow viewport. Confirm the editor remains usable after fuel exhaustion and that console errors are absent. A successful static-server startup alone does not verify the interface.

[The public CI workflow](../.github/workflows/check.yml) runs the tests and JavaScript syntax checks on Node 24 for pull requests and pushes to `main`. It is a checks workflow; it does not contain the application's hosting configuration.

## Project layout

```text
.github/workflows/check.yml  public automated tests and module syntax checks
assets/preview.png           screenshot used by the project overview
docs/
  .nojekyll                  static-hosting marker
  index.html                 workshop structure and language overview
  style.css                  responsive and reduced-motion-aware styling
  app.js                     editor, examples, stages, downloads, Worker lifecycle
  worker.js                  compile-and-run comparison job and result serialization
  core.js                    compiler, interpreter, Wasm encoder, formatting helpers
test/
  compiler.test.js           Node tests and seeded differential corpus
package.json                 runtime requirement and test/serve commands
LICENSE                      MIT license
reference/guide.md           setup, language, architecture, and development guide
README.md                    project overview and entry points
```

For a first source-reading pass, follow `compile` in `docs/core.js`, then open each function it calls. Read `test/compiler.test.js` alongside it for small executable examples. Move to `worker.js` and `app.js` after the compiler's inputs and outputs make sense.

## Static hosting

Serve the **contents of `docs/`** unchanged over HTTP or HTTPS. There is no build artifact to generate and no application secret or runtime configuration to supply. Keep the JavaScript files next to `index.html`: relative module and Worker URLs support serving the application below a repository subpath. Preserve `.nojekyll` when copying the static files to GitHub Pages.

For a fork on GitHub Pages, select a branch that contains the application and choose its `/docs` folder as the publishing source. GitHub documents branch/folder publishing in [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site). The repository's test workflow is independent of that choice.

A host must serve `.js` files as JavaScript and allow module Workers and WebAssembly compilation. Restrictive content-security policies may need appropriate settings for those browser features. After hosting, open the page, run a program, switch stages, and test a download; receiving an HTML response is only the first check.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `python3` is not found | Install Python 3 or serve `docs/` with another static HTTP server. The compiler itself has no Python dependency. |
| `Address already in use` | Choose a free port, such as the 8081 command in [Quick start](#quick-start), and use that port in the browser URL. |
| Worker fails to load or the page is opened from a file | Use an HTTP/HTTPS URL, check that `worker.js` and `core.js` are present, and inspect the browser console for MIME-type or policy errors. |
| `Expected i32, found bool` | Match the declared type. Conditions require `bool`; arithmetic requires `i32`; there is no implicit conversion. |
| A function “must return” despite a constant condition | The structural return checker does not use optimization results. Return from both branches or add a later return. |
| Positive `2147483648` is rejected | The maximum positive i32 literal is `2147483647`. The special negative form is `-2147483648`. |
| A loop or recursive program stops | Distinguish `FUEL`, interpreter `DEPTH`, Wasm stack/trap errors, and the Worker `TIMEOUT`. Simplify the program before increasing library budgets. |
| A displayed result remains from earlier source | Select **Compile & run**. Editing intentionally marks prior results as stale and disables the download. |
| No transformations appear | The supported local simplifications may not apply. First check for a compile diagnostic; a failed compilation has no emitted module. |
| “Optimized” uses a different fuel count | Removed loop checks can change fuel usage. Compare successful values, and compare fuel only between executions of the same IR. |
| A downloaded module runs once and later exhausts fuel | `__fuel` belongs to the instance and is consumed by calls. `runWasm` creates and initializes a new instance; a custom host reusing one instance must manage its budget. |
| Node tests pass but the browser fails | Node tests do not test Worker loading, UI behavior, MIME types, host policies, or browser stack limits. Reproduce the issue in the browser. |

For a bug report, include the smallest source program that reproduces it, the expected and actual result or diagnostic, whether optimization affects it, and the browser/Node version. For a trap, preserve the distinction between a semantic trap and a resource limit.

## Contributing and extending the compiler

Keep changes small enough to explain through the visible pipeline. Begin with an executable example or regression test, state the intended semantics, and update this guide and the project overview when the supported language or limits change. No installation or code-generation step is needed to edit the project.

A feature often crosses several stages:

| Change | Places to inspect |
| --- | --- |
| New syntax or operator | `tokenize`, `PRECEDENCE`, `parse`, and `lower` in `docs/core.js`; then the interpreter and encoder. |
| New primitive type | Type checking, runtime representations, function-signature deduplication, expression emission, and UI result formatting. |
| New optimization | `optimize`, arithmetic/trap semantics, source spans, and `differential` tests. |
| New control-flow construct | Structural return analysis, IR representation, interpreter control flow, Wasm branch depth, and fuel instrumentation. |
| New example | The `examples` object in `docs/app.js`, an expected-result test, and the workshop table above. |
| Better inspection | `formatIR`, `formatHex`, Worker serialization, and stage rendering in `docs/app.js`. |

For semantic changes, compare all four execution paths and test edge values, short-circuiting, traps, lexical scope, and resource limits relevant to the feature. A rewrite must preserve evaluation order and observable traps; fewer nodes alone are not sufficient evidence. Keep input and execution bounds explicit, and do not bypass the Worker to make a demo appear faster.

Useful contained extensions include a collapsible syntax-tree viewer, a token/span inspector, clearer diagnostic presentation, or a larger seeded grammar-based differential corpus. More advanced work such as mutable-value propagation, inlining, new numeric types, or SSA requires a semantics and testing plan before implementation.

Before proposing a change, run tests and syntax checks, exercise the affected browser behavior, and explain what changed and how it was verified. Include a small before/after program for optimizer or language changes. Keep unrelated reformatting and generated artifacts out of a focused contribution.

## Learning references

- [WebAssembly binary format](https://webassembly.github.io/spec/core/binary/index.html): the module format encoded by this backend.
- [LLVM's language frontend tutorial](https://llvm.org/docs/tutorial/MyFirstLanguageFrontend/index.html): an introduction to lexing, parsing, IR, and code generation. Glassbox does not use LLVM.
- [Worker termination](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate): the browser mechanism used to stop a job that exceeds the demo's time limit.

## License

MIT. See [LICENSE](../LICENSE).
