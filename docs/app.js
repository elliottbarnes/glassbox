const $ = id => document.getElementById(id);
const examples = {
  folding: `// This branch can disappear. The answer stays 42.\nfn square(x: i32) -> i32 {\n  return x * x + 0;\n}\n\nfn main() -> i32 {\n  if (3 * 7 == 21) {\n    return square(6) + (2 * 3);\n  } else {\n    return 1 / 0; // unreachable trap\n  }\n}\n`,
  gcd: `// Euclid's algorithm: mutation, loops, and calls.\nfn gcd(a: i32, b: i32) -> i32 {\n  while (b != 0) {\n    let next: i32 = a % b;\n    a = b;\n    b = next;\n  }\n  return a;\n}\n\nfn main() -> i32 {\n  return gcd(462, 1071);\n}\n`,
  factorial: `// Recursion uses the same function-call backend.\nfn factorial(n: i32) -> i32 {\n  if (n <= 1) {\n    return 1;\n  } else {\n    return n * factorial(n - 1);\n  }\n}\n\nfn main() -> i32 {\n  return factorial(7);\n}\n`,
  shortcircuit: `// The right side never runs: no division trap.\nfn wouldTrap() -> bool {\n  return 1 / 0 == 0;\n}\n\nfn main() -> bool {\n  return false && wouldTrap() || true;\n}\n`,
  budget: `// An endless loop cannot hold this page hostage.\nfn main() -> i32 {\n  let counter: i32 = 0;\n  while (true) {\n    counter = counter + 1;\n  }\n  return counter;\n}\n`
};
const stages = {
  ast: ['Source, given a shape.', 'The parser builds a tree before names and types resolve.', 'SYNTAX TREE'],
  ir: ['Names become numbered slots.', 'Typed, structured IR. Conditions and loops retain their shape.', 'STRUCTURED IR'],
  optimized: ['Less work. Same answer.', 'Constants folded, dead branches removed.', 'STRUCTURED IR'],
  wasm: ['Bytes the browser can run.', 'Actual generated WebAssembly binary, shown as hexadecimal.', 'BINARY HEX']
};
let current = null, stage = 'optimized', activeWorker = null, timeout = null, generation = 0;
function setStatus(message, error = false) { $('build-status').textContent = message; $('build-status').classList.toggle('error-status', error); }
function lineNumbers() { const count = $('source').value.split('\n').length; $('line-numbers').textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n'); $('line-numbers').scrollTop = $('source').scrollTop; $('source-info').textContent = `main.glass · ${count} lines`; }
function clearRun() { for (const id of ['result-value', 'result-reference', 'result-basic', 'result-optimized']) $(id).textContent = '—'; $('agreement').textContent = 'Waiting for execution'; $('fuel-info').textContent = '100,000 units of execution fuel'; document.querySelector('.result-strip').classList.remove('error'); }
function markStale() {
  generation++;
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; clearTimeout(timeout); $('compile').disabled = false; }
  document.querySelector('.workshop').classList.add('stale'); $('download').disabled = true; $('diagnostic').hidden = true;
  document.querySelectorAll('.change').forEach(button => { button.disabled = true; });
  setStatus('Edited · compile to refresh'); $('agreement').textContent = 'Results are from previous source'; lineNumbers();
}
function displayStage() {
  const [title, description, badge] = stages[stage]; $('stage-title').textContent = title; $('stage-description').textContent = description; $('stage-badge').textContent = badge;
  document.querySelectorAll('[data-stage]').forEach(button => { const selected = button.dataset.stage === stage; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
  $('stage-panel').setAttribute('aria-labelledby', `tab-${stage}`);
  if (!current) return;
  $('stage-code').textContent = stage === 'ast' ? JSON.stringify(current.ast, (key, value) => key === 'span' ? undefined : value, 2) : stage === 'ir' ? current.ir : stage === 'optimized' ? current.optimizedIr : current.hex;
  $('stage-code').scrollTop = 0;
  const saved = current.basicWasm.length - current.wasm.length;
  $('stage-info').textContent = stage === 'ast' ? `${current.tokens} tokens · ${current.functions} functions · source spans retained internally` : stage === 'wasm' ? `${current.wasm.length} bytes · WebAssembly.validate ✓ · optimized build` : `${current.basicWasm.length} → ${current.wasm.length} bytes · ${saved} bytes removed`;
}
function selectSpan(span) { if (!span) return; $('source').focus(); $('source').setSelectionRange(span.start, span.end); const lineHeight = parseFloat(getComputedStyle($('source')).lineHeight); $('source').scrollTop = Math.max(0, (span.line - 4) * lineHeight); $('line-numbers').scrollTop = $('source').scrollTop; }
function showError(error) {
  const prefix = error.phase ? `${error.phase}${error.span ? ` · line ${error.span.line}:${error.span.column}` : ''}` : error.code || 'Execution error';
  $('diagnostic').textContent = `${prefix}\n${error.message}`; $('diagnostic').hidden = false;
  if (error.span) selectSpan(error.span);
}
function renderChanges(changes) {
  $('change-count').textContent = `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`; $('changes').replaceChildren();
  if (!changes.length) { const p = document.createElement('p'); p.className = 'empty-log'; p.textContent = 'No transformations apply. This program still compiles and runs through the full pipeline.'; $('changes').append(p); return; }
  changes.forEach((change, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'change';
    const number = document.createElement('span'); number.className = 'change-index'; number.textContent = String(index + 1).padStart(2, '0');
    const text = document.createElement('div'); const h3 = document.createElement('h3'); h3.textContent = change.pass; const p = document.createElement('p'); p.textContent = change.detail; text.append(h3, p);
    const line = document.createElement('span'); line.className = 'change-line'; line.textContent = `L${change.span.line} ↗`;
    button.append(number, text, line); button.addEventListener('click', () => selectSpan(change.span)); $('changes').append(button);
  });
}
function renderResults(data) {
  const format = result => result.ok ? data.resultType === 'bool' ? String(Boolean(result.value)) : String(result.value) : result.error.code === 'FUEL' ? 'Fuel limit' : result.error.code === 'DEPTH' ? 'Depth limit' : 'Trapped';
  $('result-type').textContent = data.resultType; $('result-reference').textContent = format(data.reference); $('result-basic').textContent = format(data.basic); $('result-optimized').textContent = format(data.optimized);
  const allOk = data.reference.ok && data.basic.ok && data.optimized.ok;
  const agreement = allOk && data.reference.value === data.basic.value && data.basic.value === data.optimized.value;
  $('result-value').textContent = data.optimized.ok ? format(data.optimized) : '↯';
  $('agreement').textContent = agreement ? '✓ All three execution paths agree' : allOk ? 'Mismatch · inspect the source' : 'Execution stopped at a limit or trap';
  $('fuel-info').textContent = data.optimized.ok ? `${data.optimized.fuelUsed.toLocaleString()} / 100,000 fuel used · optimized Wasm` : 'The Worker completed; this page remains responsive.';
  document.querySelector('.result-strip').classList.toggle('error', !agreement);
  if (!data.reference.ok) showError(data.reference.error); else if (!data.optimized.ok) showError(data.optimized.error);
}
function run() {
  generation++; const id = generation; if (activeWorker) activeWorker.terminate(); clearTimeout(timeout);
  $('compile').disabled = true; $('download').disabled = true; $('diagnostic').hidden = true; document.querySelector('.workshop').classList.toggle('stale', Boolean(current)); document.querySelectorAll('.change').forEach(button => { button.disabled = true; }); setStatus('Compiling & checking…');
  try { activeWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); }
  catch (error) { $('compile').disabled = false; setStatus('Worker unavailable', true); showError({ message: 'Serve this page over HTTP or HTTPS to run the compiler. Opening index.html directly is not supported.' }); return; }
  const worker = activeWorker;
  const finish = () => { clearTimeout(timeout); worker.terminate(); if (activeWorker === worker) activeWorker = null; $('compile').disabled = false; };
  timeout = setTimeout(() => { if (id !== generation) return; finish(); current = null; clearRun(); setStatus('Worker stopped at 3 seconds', true); $('stage-code').textContent = 'Execution time limit reached.'; showError({ code: 'TIMEOUT', message: 'This compile-and-run job exceeded three seconds. The Worker was terminated. Try a smaller program.' }); }, 3000);
  worker.onerror = event => { if (id !== generation) return; event.preventDefault(); finish(); current = null; clearRun(); setStatus('Worker could not finish', true); showError({ message: event.message || 'Could not load the compiler Worker. Serve the docs folder over HTTP or HTTPS.' }); };
  worker.onmessage = ({ data }) => {
    if (id !== generation) return; finish();
    if (!data.ok) { current = null; clearRun(); setStatus('Compile stopped · see diagnostic', true); $('stage-code').textContent = 'Fix the source diagnostic to continue through the pipeline.'; $('stage-info').textContent = 'No module emitted'; renderChanges([]); showError(data.error); return; }
    current = data; document.querySelector('.workshop').classList.remove('stale'); $('download').disabled = false; displayStage(); renderChanges(data.changes); renderResults(data); setStatus(`Compiled · ${data.wasm.length} bytes · ${data.compileMs.toFixed(1)} ms`);
  };
  worker.postMessage({ source: $('source').value });
}
$('source').addEventListener('input', markStale);
$('source').addEventListener('scroll', () => { $('line-numbers').scrollTop = $('source').scrollTop; });
$('source').addEventListener('keydown', event => {
  if (event.key === 'Tab') { event.preventDefault(); const source = $('source'), start = source.selectionStart, end = source.selectionEnd; source.setRangeText('  ', start, end, 'end'); markStale(); }
});
$('compile').addEventListener('click', run);
$('example').addEventListener('change', () => { $('source').value = examples[$('example').value]; lineNumbers(); run(); });
$('reset').addEventListener('click', () => { $('source').value = examples[$('example').value]; lineNumbers(); run(); });
window.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); run(); } });
document.querySelectorAll('[data-stage]').forEach(button => {
  button.addEventListener('click', () => { stage = button.dataset.stage; displayStage(); });
  button.addEventListener('keydown', event => { const keys = Object.keys(stages); let index = keys.indexOf(stage); if (event.key === 'ArrowRight') index = (index + 1) % keys.length; else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = keys.length - 1; else return; event.preventDefault(); stage = keys[index]; displayStage(); $(`tab-${stage}`).focus(); });
});
$('download').addEventListener('click', () => { if (!current) return; const url = URL.createObjectURL(new Blob([current.wasm], { type: 'application/wasm' })); const a = document.createElement('a'); a.href = url; a.download = 'glassbox-main.wasm'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('shortcut').textContent = 'Ctrl ↵';
$('source').value = examples.folding; lineNumbers(); displayStage(); run();
