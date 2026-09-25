/**
 * Portable test runner: explicitly discovers test/*.test.js and passes the
 * files to `node --test`. Works the same on Windows/Linux and Node 20–24
 * (passing a directory to `node --test` breaks on Node 22+).
 * Fails loudly if no test files are found, so tests can never be silently skipped.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('test', f));

if (files.length === 0) {
  console.error('No test files found in test/*.test.js');
  process.exit(1);
}

// Run files one at a time: deterministic output and safe on low-memory machines/CI runners.
const extra = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...extra, ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
