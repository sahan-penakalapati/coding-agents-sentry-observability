#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function existingPythonCandidates() {
  const candidates = [];
  if (process.env.CODING_AGENTS_OBSERVABILITY_PYTHON) {
    candidates.push(process.env.CODING_AGENTS_OBSERVABILITY_PYTHON);
  }
  if (process.env.PYTHON) {
    candidates.push(process.env.PYTHON);
  }
  candidates.push(
    path.join(root, '.venv-npm', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    'python3',
    'python'
  );
  return candidates.filter((candidate, index) => candidate && candidates.indexOf(candidate) === index);
}

function findPython() {
  for (const candidate of existingPythonCandidates()) {
    const result = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], {
      stdio: 'ignore',
      shell: false,
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function runNodeScript(scriptName, args) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', scriptName), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status == null ? 1 : result.status);
}

const args = process.argv.slice(2);
if (args[0] === 'setup' || args[0] === 'connect-sentry') {
  runNodeScript('setup-sentry.js', args.slice(1));
}

const python = findPython();
if (!python) {
  console.error('coding-agents-observability requires Python 3.11 or newer.');
  console.error('Set PYTHON=/path/to/python or reinstall after installing Python.');
  process.exit(1);
}

const env = { ...process.env };
const srcPath = path.join(root, 'src');
env.PYTHONPATH = env.PYTHONPATH ? `${srcPath}${path.delimiter}${env.PYTHONPATH}` : srcPath;

const child = spawnSync(python, ['-m', 'agent_vm_observability', ...args], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}
if (child.signal) {
  process.kill(process.pid, child.signal);
}
process.exit(child.status == null ? 1 : child.status);
