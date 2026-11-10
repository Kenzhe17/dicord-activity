import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
const root = process.cwd();
const forbidden = [];
let checked = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'generated'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    checked++;
    const local = relative(root, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) {
      const target = specifier.startsWith('.') ? relative(root, resolve(directory, specifier)).replaceAll('\\', '/') : specifier;
      const pure = local.startsWith('packages/platform-core/') || local.startsWith('packages/shared/') || /games\/[^/]+\/engine\//.test(local);
      if (pure && (/^(react|react-dom|socket\.io|@discord\/|fastify|node:|@rize\/(discord|database))/.test(target) || /^apps\//.test(target))) forbidden.push(local + ' -> ' + target);
      if (local.startsWith('apps/web/') && (/(@rize\/database|@rize\/discord\/server|apps\/server)/.test(target))) forbidden.push(local + ' -> ' + target);
      const game = local.match(/^games\/([^/]+)\//)?.[1];
      const importedGame = target.match(/^(?:@rize\/|games\/)(durak|uno|mafia)(?:\/|$)/)?.[1];
      if (game && importedGame && game !== importedGame) forbidden.push(local + ' -> ' + target);
    }
  }
}
for (const directory of ['apps', 'packages', 'games']) await walk(join(root, directory));
if (forbidden.length) { console.error(forbidden.join('\n')); process.exitCode = 1; }
else console.log('Architecture boundaries passed (' + checked + ' source files).');
