#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const venv = path.join(root, '.venv-npm');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: options.stdio || 'inherit',
    shell: false,
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result;
}

function candidatePythons() {
  const candidates = [];
  if (process.env.CODING_AGENTS_OBSERVABILITY_PYTHON) {
    candidates.push(process.env.CODING_AGENTS_OBSERVABILITY_PYTHON);
  }
  if (process.env.PYTHON) {
    candidates.push(process.env.PYTHON);
  }
  candidates.push('python3', 'python');
  return candidates.filter((candidate, index) => candidate && candidates.indexOf(candidate) === index);
}

function findPython() {
  for (const candidate of candidatePythons()) {
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

function venvPython() {
  return path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function truthy(value) {
  return /^(1|true|yes)$/i.test(value || '');
}

if (truthy(process.env.CODING_AGENTS_OBSERVABILITY_SKIP_POSTINSTALL)) {
  console.log('coding-agents-observability: skipping Python dependency install.');
  process.exit(0);
}

const python = findPython();
if (!python) {
  console.error('coding-agents-observability requires Python 3.11 or newer.');
  console.error('Set PYTHON=/path/to/python and run npm install again.');
  process.exit(1);
}

try {
  if (!fs.existsSync(venvPython())) {
    run(python, ['-m', 'venv', venv]);
  }
  const py = venvPython();
  run(py, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(py, ['-m', 'pip', 'install', '.']);
  console.log('coding-agents-observability: installed Python runtime into package .venv-npm');
} catch (error) {
  console.error(`coding-agents-observability postinstall failed: ${error.message}`);
  console.error('Install Python 3.11+, or set CODING_AGENTS_OBSERVABILITY_SKIP_POSTINSTALL=1 and manage Python dependencies yourself.');
  process.exit(1);
}

if (truthy(process.env.CODING_AGENTS_OBSERVABILITY_SKIP_SETUP) || truthy(process.env.CI) || !process.stdin.isTTY) {
  console.log('coding-agents-observability: run `coding-agents-observability setup` to connect Sentry.');
  process.exit(0);
}

try {
  run(process.execPath, [path.join(root, 'scripts', 'setup-sentry.js')]);
} catch (error) {
  console.error(`coding-agents-observability setup failed: ${error.message}`);
  console.error('You can retry with `coding-agents-observability setup`.');
}
