import { z } from 'zod';
import {
  aliasMutationResultSchema, aliasMutationSchema, aliasNameSchema, aliasSnapshotSchema, canonicalCommandSchema,
  type AliasMutationResult, type AliasSnapshot,
} from '../../shared/schemas/alias.js';
import { emptyInputSchema, revisionSchema, type ModuleMetadata } from '../../shared/schemas/index.js';
import type { ActionExecutor } from '../actions.js';
import { AppError } from '../errors.js';
import { JsonDocument, type JsonStorage } from '../storage.js';

export const aliasMetadata: ModuleMetadata = {
  id: 'alias', nameKey: 'web:modules.aliasName', descriptionKey: 'web:modules.aliasDescription',
  schema_version: 1, configurable: false,
};

type AliasDocument = AliasSnapshot & { schema_version: 1 };
const emptyAliases: readonly string[] = Object.freeze([]);

export class AliasService {
  private readonly commands: ReadonlySet<string>;
  private readonly file: JsonDocument<AliasDocument>;
  private initialization?: Promise<void>;

  constructor(storage: JsonStorage, commandNames: readonly string[]) {
    for (const command of commandNames) {
      const parsed = canonicalCommandSchema.safeParse(command);
      if (!parsed.success || parsed.data !== command) throw new AppError('INVALID_INPUT', ['command']);
    }
    this.commands = new Set(commandNames);
    const schema = aliasSnapshotSchema.safeExtend({ schema_version: z.literal(1) }).superRefine((value, context) => {
      for (const [command, aliases] of Object.entries(value.aliases)) {
        if (!this.commands.has(command)) context.addIssue({ code: 'custom', path: ['aliases', command], message: 'Unknown command' });
        for (const alias of aliases) {
          if (this.commands.has(alias)) context.addIssue({ code: 'custom', path: ['aliases', command], message: 'Canonical command collision' });
        }
      }
    });
    this.file = new JsonDocument(storage, 'aliases.json', schema);
  }

  initialize(): Promise<void> {
    const aliases: Record<string, string[]> = {};
    if (this.commands.has('help')) aliases.help = ['\u5e2e\u52a9', '\u5e6b\u52a9', '\u30d8\u30eb\u30d7'];
    if (this.commands.has('alias')) aliases.alias = ['\u522b\u540d', '\u5225\u540d', '\u30a8\u30a4\u30ea\u30a2\u30b9'];
    return this.initialization ??= this.file.load({ schema_version: 1, revision: 0, aliases });
  }

  snapshot(): AliasDocument { return this.file.snapshot(); }

  resolve(name: string): string | undefined {
    const parsed = aliasNameSchema.safeParse(name);
    if (!parsed.success) return undefined;
    // Derive from the committed snapshot, so a reverse cache can never outlive a failed write.
    const reverse = new Map(Object.entries(this.file.snapshot().aliases)
      .flatMap(([command, aliases]) => aliases.map(alias => [alias, command] as const)));
    return reverse.get(parsed.data);
  }

  forCommand(command: string): readonly string[] {
    const parsed = canonicalCommandSchema.safeParse(command);
    if (!parsed.success || !this.commands.has(parsed.data)) return emptyAliases;
    const aliases = this.file.snapshot().aliases;
    return Object.hasOwn(aliases, parsed.data) ? aliases[parsed.data]! : emptyAliases;
  }

  add(command: string, alias: string, revision: number, signal?: AbortSignal): Promise<AliasMutationResult> {
    return this.mutate(command, alias, revision, false, signal);
  }

  remove(command: string, alias: string, revision: number, signal?: AbortSignal): Promise<AliasMutationResult> {
    return this.mutate(command, alias, revision, true, signal);
  }

  private async mutate(command: string, alias: string, revision: number, remove: boolean, signal?: AbortSignal): Promise<AliasMutationResult> {
    const target = canonicalCommandSchema.safeParse(command);
    if (!target.success || !this.commands.has(target.data)) throw new AppError('INVALID_INPUT', ['command']);
    const name = aliasNameSchema.safeParse(alias);
    if (!name.success) throw new AppError('INVALID_INPUT', ['alias']);
    if (!revisionSchema.safeParse(revision).success) throw new AppError('INVALID_INPUT', ['revision']);
    const result = await this.file.update(candidate => {
      if (!remove && this.commands.has(name.data)) throw new AppError('CONFLICT', ['alias']);
      const reverse = new Map(Object.entries(candidate.aliases)
        .flatMap(([key, aliases]) => aliases.map(value => [value, key] as const)));
      const existing = reverse.get(name.data);
      if (remove) {
        if (existing !== target.data) throw new AppError('NOT_FOUND');
        const aliases = candidate.aliases[target.data]!.filter(value => value !== name.data);
        if (aliases.length) candidate.aliases[target.data] = aliases;
        else delete candidate.aliases[target.data];
      } else {
        if (existing === target.data) return false;
        if (existing !== undefined) throw new AppError('CONFLICT', ['alias']);
        const aliases = Object.hasOwn(candidate.aliases, target.data) ? candidate.aliases[target.data]! : [];
        if (aliases.length >= 8) throw new AppError('INVALID_INPUT', ['alias']);
        candidate.aliases[target.data] = [...aliases, name.data];
      }
    }, { revision, signal });
    return { command: target.data, alias: name.data, changed: result.changed, revision: result.snapshot.revision };
  }
}

export function registerAliasActions(executor: Pick<ActionExecutor, 'register'>, service: AliasService): void {
  const common = {
    permission: 'superadmin', scopes: ['private'], sources: ['telegram', 'http'], aiVisible: false, timeoutMs: 15_000,
  } as const;
  executor.register({ ...common, id: 'alias.list', input: emptyInputSchema, output: aliasSnapshotSchema, effect: 'read',
    execute: () => { const { revision, aliases } = service.snapshot(); return { revision, aliases }; },
  });
  executor.register({ ...common, id: 'alias.add', input: aliasMutationSchema, output: aliasMutationResultSchema, effect: 'permission',
    execute: (input, context) => service.add(input.command, input.alias, input.revision, context.signal),
  });
  executor.register({ ...common, id: 'alias.remove', input: aliasMutationSchema, output: aliasMutationResultSchema, effect: 'permission',
    execute: (input, context) => service.remove(input.command, input.alias, input.revision, context.signal),
  });
}
