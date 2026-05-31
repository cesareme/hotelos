#!/usr/bin/env node
import { execSync } from 'node:child_process';

const checks = [
  'scripts/check-sidebar-coverage.mjs',
  'scripts/check-route-validity.mjs',
  'scripts/check-placeholder-budget.mjs'
];

let failures = 0;
for (const check of checks) {
  process.stdout.write(`Running ${check}... `);
  try {
    execSync(`node ${check}`, { stdio: 'inherit' });
    console.log('✅');
  } catch (err) {
    console.log('❌');
    failures++;
  }
}

process.exit(failures > 0 ? 1 : 0);
