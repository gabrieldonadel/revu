#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const appRoot = realpathSync(process.cwd());
const configPath = ts.findConfigFile(appRoot, ts.sys.fileExists, 'tsconfig.json');

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => appRoot,
  getNewLine: () => ts.sys.newLine,
};

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost);
}

function failConfiguration(diagnostics) {
  process.stderr.write(formatDiagnostics(diagnostics));
  process.exit(1);
}

if (!configPath) {
  console.error(`[typecheck] Could not find tsconfig.json under ${appRoot}.`);
  process.exit(1);
}

const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
if (configResult.error) {
  failConfiguration([configResult.error]);
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configResult.config,
  ts.sys,
  dirname(configPath),
  { noEmit: true },
  configPath,
);
if (parsedConfig.errors.length > 0) {
  failConfiguration(parsedConfig.errors);
}

const program = ts.createProgram({
  rootNames: parsedConfig.fileNames,
  options: parsedConfig.options,
  projectReferences: parsedConfig.projectReferences,
});
const diagnostics = ts.sortAndDeduplicateDiagnostics(ts.getPreEmitDiagnostics(program));

function canonicalPath(fileName) {
  try {
    return realpathSync(fileName);
  } catch {
    return resolve(fileName);
  }
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function isAppOwnedFile(fileName) {
  const lexicalPath = resolve(fileName);
  const lexicalRelative = relative(appRoot, lexicalPath);
  if (
    lexicalRelative === 'node_modules' ||
    lexicalRelative.startsWith(`node_modules${sep}`)
  ) {
    return false;
  }
  return isWithin(appRoot, canonicalPath(lexicalPath));
}

const appDiagnostics = diagnostics.filter(
  (diagnostic) => !diagnostic.file || isAppOwnedFile(diagnostic.file.fileName),
);
const suppressedDiagnostics = diagnostics.filter(
  (diagnostic) => diagnostic.file && !isAppOwnedFile(diagnostic.file.fileName),
).length;

if (appDiagnostics.length > 0) {
  process.stderr.write(formatDiagnostics(appDiagnostics));
}
if (suppressedDiagnostics > 0) {
  console.log(
    `[typecheck] Suppressed ${suppressedDiagnostics} linked-source/non-app ` +
      `diagnostic${suppressedDiagnostics === 1 ? '' : 's'}; run ` +
      '`bun run typecheck:all` for the full graph.',
  );
}

process.exit(appDiagnostics.length > 0 ? 1 : 0);
