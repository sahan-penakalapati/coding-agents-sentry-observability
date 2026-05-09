#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function existingPythonCandidates() {
  const candidates = [];
  if (process.env.AGENT_USAGE_OBSERVABILITY_PYTHON) {
    candidates.push(process.env.AGENT_USAGE_OBSERVABILITY_PYTHON);
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

const python = findPython();
if (!python) {
  console.error('agent-usage-observability requires Python 3.11 or newer.');
  console.error('Set PYTHON=/path/to/python or reinstall without AGENT_USAGE_OBSERVABILITY_SKIP_POSTINSTALL.');
  process.exit(1);
}

const env = { ...process.env };
const srcPath = path.join(root, 'src');
env.PYTHONPATH = env.PYTHONPATH ? `${srcPath}${path.delimiter}${env.PYTHONPATH}` : srcPath;

const child = spawnSync(python, ['-m', 'agent_vm_observability', ...process.argv.slice(2)], {
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
