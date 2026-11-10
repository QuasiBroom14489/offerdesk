#!/usr/bin/env node
// Local, read-only source adapter. Only explicitly selected notes are read.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Offerdesk } from '../packages/core/dist/index.js';

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'data/profile-sources.json' },
      vault: { type: 'string' },
      resume: { type: 'string' },
      note: { type: 'string', multiple: true },
      db: { type: 'string', default: 'data/offerdesk.db' },
      export: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/profile-import.mjs --vault /path/to/LifeVault --resume /path/to/resume.pdf --note "Career/Experience.md" [--note "Projects/Project.md"] [--db data/offerdesk.db] [--export data/profile-import.json]\nConfiguration is saved locally in data/profile-sources.json. Later: node scripts/profile-import.mjs\nOnly allowlisted Markdown files are read. Symlinks, hidden files and traversal are rejected. No network or AI calls. --export creates a private selected-source package instead of writing the local database.',
    );
    process.exit(0);
  }
  const configPath = resolve(values.config);
  let previous = {};
  try {
    previous = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const config = {
    vault: values.vault ?? previous.vault,
    resume: values.resume ?? previous.resume,
    notes: values.note ?? previous.notes ?? [],
  };
  // Resolve output parents too: configuration/export/database writes must never touch the vault.
  const vaultRoot = config.vault ? await realpath(config.vault) : null;
  for (const output of [
    configPath,
    resolve(values.db),
    ...(values.export ? [resolve(values.export)] : []),
  ]) {
    let parent = dirname(output);
    const tail = [basename(output)];
    while (true) {
      try {
        parent = await realpath(parent);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || dirname(parent) === parent) throw error;
        tail.unshift(basename(parent));
        parent = dirname(parent);
      }
    }
    const actualOutput = resolve(parent, ...tail);
    if (vaultRoot && (actualOutput === vaultRoot || actualOutput.startsWith(vaultRoot + sep)))
      throw new Error('Output must stay outside the read-only vault');
    if (config.resume && actualOutput === (await realpath(config.resume)))
      throw new Error('Output must not overwrite the resume');
  }
  const files = [];
  if (config.vault && config.notes.length) {
    const root = await realpath(config.vault);
    for (const note of config.notes) {
      if (
        typeof note !== 'string' ||
        !/\.md$/i.test(note) ||
        note.split(/[\\/]/).some((part) => !part || part === '..' || part.startsWith('.'))
      )
        throw new Error('Choose relative, non-hidden Markdown notes');
      const candidate = resolve(root, note);
      const rel = relative(root, candidate);
      if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(candidate) === root)
        throw new Error('Note outside configured vault');
      let cursor = root;
      for (const part of rel.split(sep)) {
        cursor = resolve(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink())
          throw new Error('Symlink source paths are not allowed');
      }
      const actual = await realpath(candidate);
      if (actual !== candidate) throw new Error('Source path changed');
      const stat = await lstat(actual);
      if (!stat.isFile() || stat.size > 500_000)
        throw new Error('Source must be a regular Markdown file under 500 KB');
      files.push({
        name: rel.split(sep).join('/'),
        kind: 'markdown',
        content: await readFile(actual, 'utf8'),
      });
    }
  }
  if (config.resume) {
    const path = resolve(config.resume);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_000_000)
      throw new Error('Resume must be a regular PDF under 4 MB');
    files.unshift({
      name: basename(path),
      kind: 'resume',
      content: (await readFile(path)).toString('base64'),
    });
  }
  if (!files.length) throw new Error('Select a resume or professional Markdown notes; use --help');
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (values.export) {
    await mkdir(dirname(resolve(values.export)), { recursive: true });
    await writeFile(resolve(values.export), JSON.stringify({ files }), { mode: 0o600 });
    console.log(`Prepared ${files.length} selected sources. Treat this package as private.`);
  } else {
    const desk = await Offerdesk.open(resolve(values.db));
    try {
      const result = await desk.profile.sync({ files });
      console.log(
        JSON.stringify({
          processed: result.processed,
          unchanged: result.unchanged,
          pending: result.facts.filter((f) => f.status === 'pending').length,
          canonical: result.entries.length,
        }),
      );
    } finally {
      desk.db.close();
    }
  }
}
main().catch(() => {
  console.error(
    'Source import failed. Verify selected files, paths, formats and database access. No source content is logged.',
  );
  process.exitCode = 1;
});
