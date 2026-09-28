#!/usr/bin/env node

// Symlinks the source-linked @exact packages named by exact.links.json into
// node_modules. Wired as the `postinstall` script, so every `bun install`
// (re)creates the links after bun finishes managing the third-party deps.
//
// Why not dependency specs (ENG-23265, previously ENG-22451): bun 1.3
// stopped resolving `link:<path>` specs (the protocol now only accepts
// globally registered `bun link` names), and `file:` specs copy the package
// and then fail on its `workspace:*` ranges. Direct symlinks keep the
// original design: linked packages resolve their own deps through their
// real location — the Exact checkout's installed node_modules.

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const links = JSON.parse(readFileSync(join(appDir, 'exact.links.json'), 'utf8'));

let failures = 0;
for (const [name, relativeTarget] of Object.entries(links)) {
  const target = resolve(appDir, relativeTarget);
  if (!existsSync(join(target, 'package.json'))) {
    console.error(
      `[link-exact] ${name}: no package at ${target} — has the Exact checkout moved? ` +
        'Update exact.links.json to point at it.',
    );
    failures += 1;
    continue;
  }
  const linkPath = join(appDir, 'node_modules', name);
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    lstatSync(linkPath);
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // nothing at linkPath yet
  }
  symlinkSync(target, linkPath, 'dir');
}

if (failures > 0) {
  process.exit(1);
}
console.log(`[link-exact] linked ${Object.keys(links).length} @exact packages`);
