// Runs the whole integration suite sequentially with a short cooldown between
// tests so each tsx server fully releases its port and CPU before the next
// spins up (back-to-back launches starve the solo-bot navigation tests and
// make their time budgets flaky). A test that fails is retried once; only a
// second failure is fatal. Exits non-zero if anything is still red.

import { spawn } from 'node:child_process';

const TESTS = ['check-bones', 'smoke', 'playthrough', 'boss', 'stratagems', 'dive', 'nests', 'loadout', 'progression', 'difficulty', 'galaxy'];
const COOLDOWN_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(name) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [`scripts/${name}.mjs`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => {
      const line = out.split('\n').reverse().find((l) => /PASS|FAIL/.test(l)) ?? '(no result line)';
      resolve({ code, line: line.trim() });
    });
  });
}

const results = [];
for (const name of TESTS) {
  process.stdout.write(`${name.padEnd(12)} … `);
  let r = await run(name);
  if (r.code !== 0) {
    process.stdout.write('retry … ');
    await sleep(COOLDOWN_MS);
    r = await run(name);
  }
  console.log(r.code === 0 ? `✓  ${r.line}` : `✗  ${r.line}`);
  results.push({ name, ok: r.code === 0, line: r.line });
  await sleep(COOLDOWN_MS);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} suites green`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
console.log('ALL GREEN');
