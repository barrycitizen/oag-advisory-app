// Test helpers: load the REAL functions out of index.html and the Netlify
// functions, so unit tests exercise the shipped code rather than copies.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

// Pulls `function name(...) { ... }` / `const NAME = ...;` source out of
// index.html's inline script by brace/bracket matching (skipping strings and
// template literals), then evaluates them together in one sandbox.
function extractFromIndex(names) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
  const pieces = names.map((name) => {
    const re = new RegExp(`(^|\\n)((?:async )?function ${name}\\s*\\(|const ${name}\\s*=)`);
    const m = re.exec(script);
    if (!m) throw new Error(`not found in index.html: ${name}`);
    const start = m.index + m[1].length;
    return script.slice(start, findEnd(script, start));
  });
  return pieces.join('\n');
}

// Walks forward from `start`, tracking (), [], {} depth and skipping string,
// template and comment contents; ends at the first top-level `}` of a
// function body, or the `;` closing a const declaration.
function findEnd(src, start) {
  let depth = 0, i = start, seenOpen = false;
  const isFn = /^(async )?function/.test(src.slice(start, start + 15));
  const tmplStack = [];
  while (i < src.length) {
    const ch = src[i], next = src[i + 1];
    if (ch === '/' && next === '/') { i = src.indexOf('\n', i); continue; }
    if (ch === '/' && next === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (ch === '/' && regexCanStart(src, i)) { i = skipRegex(src, i); continue; }
    if (ch === '"' || ch === "'") { i = skipString(src, i, ch); continue; }
    if (ch === '`') { i = skipTemplate(src, i); continue; }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; if (ch === '{') seenOpen = true; }
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (isFn && seenOpen && depth === 0 && ch === '}') return i + 1;
    } else if (!isFn && ch === ';' && depth === 0) return i + 1;
    i++;
  }
  throw new Error('unterminated declaration');
}
// A '/' starts a regex literal (not division) when the previous significant
// character can't end an expression.
function regexCanStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(src[j])) return true;
  return /\b(return|typeof|case|in|of|delete|void|throw|new)$/.test(src.slice(Math.max(0, j - 8), j + 1));
}
function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i++; break; }
    i++;
  }
  while (/[a-z]/i.test(src[i])) i++; // flags
  return i;
}
function skipString(src, i, q) {
  i++;
  while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
  return i + 1;
}
function skipTemplate(src, i) {
  i++;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') {
      // skip the ${ ... } expression, which may itself contain strings/templates
      let d = 1; i += 2;
      while (i < src.length && d > 0) {
        const c = src[i];
        if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
        if (c === '`') { i = skipTemplate(src, i); continue; }
        if (c === '{') d++; else if (c === '}') d--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i + 1;
}

// Evaluates the named index.html declarations (plus any extra source) and
// returns the sandbox, so tests can call them as ctx.fnName(...).
function loadIndex(names, extraGlobals = {}) {
  const ctx = vm.createContext({ console, Math, Number, Date, JSON, Object, Array, Set, Map, String, isFinite, ...extraGlobals });
  const src = extractFromIndex(names);
  vm.runInContext(src + '\n' + names.filter((n) => /^[A-Z_]+$/.test(n)).map((n) => `globalThis.${n} = ${n};`).join('\n'), ctx);
  return ctx;
}

// Loads a Netlify function file with @supabase/supabase-js stubbed out (no
// network), exposing its top-level function declarations on the sandbox.
function loadFunction(file, supabaseStub = {}) {
  const dir = path.join(ROOT, 'netlify', 'functions');
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const req = (m) => (m === '@supabase/supabase-js'
    ? { createClient: () => supabaseStub }
    : require(m.startsWith('.') ? path.join(dir, m) : m));
  const ctx = vm.createContext({ require: req, module: { exports: {} }, exports: {}, process, console, fetch: () => { throw new Error('network disabled in unit tests'); } });
  vm.runInContext(src, ctx);
  return ctx;
}

module.exports = { loadIndex, loadFunction };
