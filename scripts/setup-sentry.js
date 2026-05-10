#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const configDir = path.join(os.homedir(), '.config', 'agent-vm-observability');
const configPath = path.join(configDir, 'env');
const sentryProjectUrl = 'https://sentry.io/projects/';

function createInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question, defaultValue = '') {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => resolve(answer.trim() || defaultValue));
  });
}

async function askSecret(question) {
  if (!process.stdin.isTTY) {
    const rl = createInterface();
    const answer = await ask(rl, question);
    rl.close();
    return answer;
  }
  const mutableStdout = new Proxy(process.stdout, {
    get(target, prop) {
      if (prop === 'write') {
        return chunk => {
          if (rl.stdoutMuted && typeof chunk === 'string') {
            const visible = chunk.replace(/[^\r\n]/g, '*');
            return target.write(visible);
          }
          return target.write(chunk);
        };
      }
      return target[prop];
    },
  });
  const secretRl = readline.createInterface({ input: process.stdin, output: mutableStdout, terminal: true });
  secretRl.stdoutMuted = true;
  return new Promise(resolve => {
    secretRl.question(`${question}: `, answer => {
      secretRl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).replace(/^export\s+/, '').trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function writeConfig(values) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(configPath) ? parseEnv(fs.readFileSync(configPath, 'utf8')) : new Map();
  for (const [key, value] of Object.entries(values)) {
    if (value !== '') {
      existing.set(key, value);
    }
  }
  const preferredOrder = [
    'SENTRY_DSN',
    'SENTRY_ORG',
    'SENTRY_PROJECT',
    'SENTRY_PROJECT_ID',
    'SENTRY_AUTH_TOKEN',
    'SENTRY_TRACES_SAMPLE_RATE',
    'AGENT_SENTRY_INCLUDE_TEXT',
    'AGENT_VM_RECORD_MEMORY',
    'AGENT_VM_PI_SESSION_GLOB',
    'AGENT_VM_PI_SUGGESTER_GLOB',
  ];
  const keys = [...preferredOrder, ...[...existing.keys()].filter(key => !preferredOrder.includes(key))];
  const lines = [
    '# coding-agents-observability config',
    '# Created by `coding-agents-observability setup`.',
  ];
  for (const key of keys) {
    if (existing.has(key)) {
      lines.push(`${key}=${shellQuote(existing.get(key))}`);
    }
  }
  fs.writeFileSync(configPath, `${lines.join('\n')}\n`, { mode: 0o600 });
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return spawnSync(command, args, { stdio: 'ignore', shell: false }).status === 0;
}

function pythonCandidates() {
  const candidates = [];
  if (process.env.CODING_AGENTS_OBSERVABILITY_PYTHON) candidates.push(process.env.CODING_AGENTS_OBSERVABILITY_PYTHON);
  if (process.env.PYTHON) candidates.push(process.env.PYTHON);
  candidates.push(
    path.join(root, '.venv-npm', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    'python3',
    'python'
  );
  return candidates.filter((candidate, index) => candidate && candidates.indexOf(candidate) === index);
}

function findPython() {
  for (const candidate of pythonCandidates()) {
    const result = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function runPython(args) {
  const python = findPython();
  if (!python) {
    console.error('Python 3.11+ was not found; skipping verification.');
    return 1;
  }
  const env = { ...process.env, PYTHONPATH: path.join(root, 'src') };
  const result = spawnSync(python, ['-m', 'agent_vm_observability', ...args], { cwd: process.cwd(), env, stdio: 'inherit' });
  return result.status == null ? 1 : result.status;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: coding-agents-observability setup [--no-browser] [--no-test]');
    process.exit(0);
  }

  if (!process.stdin.isTTY && !args.has('--force')) {
    console.log('coding-agents-observability setup needs an interactive terminal.');
    console.log(`Run it manually: coding-agents-observability setup`);
    return 0;
  }

  console.log('\nConnect coding-agents-observability to Sentry');
  console.log('This writes local config to ~/.config/agent-vm-observability/env.\n');

  if (!args.has('--no-browser')) {
    const opened = openBrowser(sentryProjectUrl);
    console.log(opened ? 'Opened Sentry in your browser.' : `Open Sentry in your browser: ${sentryProjectUrl}`);
    console.log('Create or select a Python project, then copy its DSN.\n');
  }

  const existing = fs.existsSync(configPath) ? parseEnv(fs.readFileSync(configPath, 'utf8')) : new Map();
  const rl = createInterface();
  const sentryDsn = await ask(rl, 'Sentry DSN', existing.get('SENTRY_DSN') || '');
  const sentryOrg = await ask(rl, 'Sentry organization slug', existing.get('SENTRY_ORG') || '');
  const sentryProject = await ask(rl, 'Sentry project slug', existing.get('SENTRY_PROJECT') || 'agent-vm-usage');
  const sentryProjectId = await ask(rl, 'Sentry numeric project id (optional, needed for dashboards)', existing.get('SENTRY_PROJECT_ID') || '');
  const includeText = await ask(rl, 'Export redacted raw text? 0=no, 1=yes', existing.get('AGENT_SENTRY_INCLUDE_TEXT') || '0');
  rl.close();

  let sentryAuthToken = existing.get('SENTRY_AUTH_TOKEN') || '';
  if (sentryOrg || sentryProjectId) {
    const tokenRl = createInterface();
    const wantsToken = await ask(tokenRl, 'Add a Sentry auth token for dashboard provisioning? y/N', sentryAuthToken ? 'y' : 'N');
    tokenRl.close();
    if (/^y(es)?$/i.test(wantsToken)) {
      sentryAuthToken = await askSecret('Sentry auth token');
    }
  }

  writeConfig({
    SENTRY_DSN: sentryDsn,
    SENTRY_ORG: sentryOrg,
    SENTRY_PROJECT: sentryProject,
    SENTRY_PROJECT_ID: sentryProjectId,
    SENTRY_AUTH_TOKEN: sentryAuthToken,
    SENTRY_TRACES_SAMPLE_RATE: existing.get('SENTRY_TRACES_SAMPLE_RATE') || '1.0',
    AGENT_SENTRY_INCLUDE_TEXT: includeText,
    AGENT_VM_RECORD_MEMORY: existing.get('AGENT_VM_RECORD_MEMORY') || '1',
  });
  console.log(`\nSaved config: ${configPath}`);

  if (!args.has('--no-test') && sentryDsn) {
    const testRl = createInterface();
    const sendTest = await ask(testRl, 'Send a Sentry self-test event now? y/N', 'N');
    testRl.close();
    if (/^y(es)?$/i.test(sendTest)) {
      runPython(['self-test']);
    }
  }

  if (sentryAuthToken && sentryOrg && sentryProjectId) {
    const dashRl = createInterface();
    const applyDashboards = await ask(dashRl, 'Apply the Sentry dashboard now? y/N', 'N');
    dashRl.close();
    if (/^y(es)?$/i.test(applyDashboards)) {
      runPython(['sentry', 'apply-dashboards']);
    }
  }

  console.log('\nNext steps:');
  console.log('  coding-agents-observability status');
  console.log('  coding-agents-observability backfill --minutes 30 --dry-run');
  console.log('  coding-agents-observability bridge --loop');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
