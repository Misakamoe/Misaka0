import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

async function eagerImports(root: string): Promise<Set<string>> {
  const imports = new Set<string>();
  const visited = new Set<string>();
  async function visit(filename: string): Promise<void> {
    if (visited.has(filename)) return;
    visited.add(filename);
    const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly || clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every(binding => binding.isTypeOnly)) continue;
        specifier = node.moduleSpecifier;
      } else if (ts.isExportDeclaration(node)) {
        if (node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(binding => binding.isTypeOnly)) continue;
        specifier = node.moduleSpecifier;
      }
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const name = specifier.text;
      if (!name.startsWith('.')) { imports.add(name); continue; }
      const target = resolve(dirname(filename), name.replace(/\.js$/, '.ts'));
      imports.add(relative(process.cwd(), target));
      if (target.endsWith('.ts')) await visit(target);
    }
  }
  await visit(resolve(root));
  return imports;
}

describe('lean eager import boundaries', () => {
  it.each(['src/modules/index.ts', 'src/actions.ts'])('%s registers metadata/contracts without loading service implementations', async root => {
    const imports = await eagerImports(root);
    expect([...imports].filter(name => /^src\/modules\/(?:alias|rss|rate|weather|sticker|subconv)\.ts$/.test(name))).toEqual([]);
  });

  it('keeps optional HTTP, parsers, currency catalogs and native execution out of application imports', async () => {
    const imports = await eagerImports('src/app.ts');
    const optional = /^(?:fastify|@fastify\/|openid-client|sharp|@lottiefiles\/|fflate|decimal\.js|cldr-core\/|fast-xml-parser|htmlparser2|linkify-it|tlds)/;
    expect([...imports].filter(name => optional.test(name))).toEqual([]);
    expect(imports.has('src/telegram/rss.ts')).toBe(false);
    expect(imports.has('src/modules/sticker-media.ts')).toBe(false);
  });

  it('does not load OIDC for Mini App authentication', async () => {
    expect((await eagerImports('src/web/auth.ts')).has('openid-client')).toBe(false);
  });

  it('validates RSS state before loading execution and drains a cancelled lazy import', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'misaka-lazy-rss-'));
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const fetchFeed = vi.fn(); let imports = 0;
    vi.doMock('../src/modules/rss-feed.js', async () => { imports++; entered.resolve(); await release.promise; return { fetchFeed }; });
    const { JsonStorage } = await import('../src/storage.js');
    const { RssService } = await import('../src/modules/rss.js');
    const storage = new JsonStorage(directory);
    const rss = new RssService(storage, { allowed: () => true, send: async () => {} });
    try {
      await storage.initialize(); await rss.initialize();
      expect(rss.snapshot().revision).toBe(0); expect(imports).toBe(0);
      const add = rss.add({ kind: 'private', chatId: 1 }, { url: 'https://feeds.example.com/rss' }, 'en');
      const cancelled = expect(add).rejects.toThrow('CANCELLED');
      await entered.promise;
      let stopped = false;
      const stop = rss.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release.resolve(); await cancelled; await stop;
      expect(imports).toBe(1); expect(fetchFeed).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await rss.stop(); await storage.close();
      await rm(directory, { recursive: true, force: true });
      vi.doUnmock('../src/modules/rss-feed.js'); vi.resetModules();
    }
  });
});
