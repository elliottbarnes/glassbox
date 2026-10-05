import { compile, emitWasm, interpret, runWasm, formatIR, formatHex } from './core.js';
const errorInfo = error => ({ name: error.name, message: error.message, phase: error.phase, code: error.code, span: error.span });
const attempt = async work => { try { return { ok: true, ...(await work()) }; } catch (error) { return { ok: false, error: errorInfo(error) }; } };
self.onmessage = async ({ data }) => {
  try {
    const started = performance.now();
    const compiled = compile(data.source);
    const basicBytes = emitWasm(compiled.ir);
    const compileMs = performance.now() - started;
    const reference = await attempt(() => interpret(compiled.ir, { fuel: 100000, maxDepth: 128 }));
    const basic = await attempt(() => runWasm(basicBytes));
    const optimized = await attempt(() => runWasm(compiled.wasm));
    self.postMessage({ ok: true, ast: compiled.ast, ir: formatIR(compiled.ir), optimizedIr: formatIR(compiled.optimizedIr), changes: compiled.changes, wasm: compiled.wasm, basicWasm: basicBytes,
      hex: formatHex(compiled.wasm), basicHex: formatHex(basicBytes), tokens: compiled.tokens, functions: compiled.ir.functions.length, resultType: compiled.resultType,
      compileMs, reference, basic, optimized });
  } catch (error) { self.postMessage({ ok: false, error: errorInfo(error) }); }
};
