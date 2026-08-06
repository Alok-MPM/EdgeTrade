import { supabase } from './supabaseClient.js';

const rootEl = document.getElementById('preview-root');

document.getElementById('back-btn').onclick = () => {
  window.location.href = './index.html';
};

function showError(title, detail) {
  rootEl.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText =
    'font-family:monospace;background:#18181b;color:#f87171;padding:24px;' +
    'white-space:pre-wrap;min-height:100vh;box-sizing:border-box;font-size:13px;line-height:1.6;';
  box.textContent = title + '\n\n' + detail;
  rootEl.appendChild(box);
}

function stripExt(name) {
  return name.replace(/\.(jsx|tsx|js|ts)$/i, '');
}

function findFile(files, importPath) {
  const clean = importPath.replace(/^\.\//, '');
  const cleanNoExt = stripExt(clean);
  return files.find(
    (f) => f.type === 'file' && (f.name === clean || stripExt(f.name) === cleanNoExt)
  );
}

async function run() {
  const { data: files, error } = await supabase
    .from('files')
    .select('id, name, type, content')
    .eq('type', 'file');

  if (error) {
    showError('Could not load project from Supabase', error.message);
    return;
  }
  if (!files || files.length === 0) {
    showError('No files found', 'The project has no files to preview yet.');
    return;
  }

  const entry = files.find((f) => f.name === 'App.jsx' || f.name === 'App.js') || files[0];

  const cache = {};

  function requireModule(importPath) {
    if (importPath === 'react') return window.React;
    if (importPath === 'react-dom' || importPath === 'react-dom/client') return window.ReactDOM;

    const file = findFile(files, importPath);
    if (!file) {
      throw new Error(
        'Cannot resolve import "' + importPath + '". ' +
        "Preview only supports local file imports plus 'react' / 'react-dom' — " +
        'external packages like icon libraries aren\'t available here.'
      );
    }
    if (cache[file.id]) return cache[file.id].exports;

    const mod = { exports: {} };
    cache[file.id] = mod; // set before executing, in case of circular imports

    let transpiled;
    try {
      transpiled = window.Babel.transform(file.content || '', {
        presets: [['react', { runtime: 'classic' }]],
        plugins: ['transform-modules-commonjs'],
        filename: file.name,
      }).code;
    } catch (err) {
      throw new Error('Syntax error in ' + file.name + ':\n' + err.message);
    }

    const fn = new Function('module', 'exports', 'require', 'React', transpiled);
    try {
      fn(mod, mod.exports, requireModule, window.React);
    } catch (err) {
      throw new Error('Runtime error in ' + file.name + ':\n' + err.message);
    }
    return mod.exports;
  }

  try {
    const entryModule = requireModule(entry.name);
    const Component = entryModule.default || entryModule;
    if (typeof Component !== 'function') {
      throw new Error(entry.name + " doesn't export a default React component.");
    }
    const root = window.ReactDOM.createRoot(rootEl);
    root.render(window.React.createElement(Component));
  } catch (err) {
    showError('Preview failed to render', err.message);
  }
}

run();
