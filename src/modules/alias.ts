import { z } from 'zod';
import {
  aliasNameSchema, aliasSnapshotSchema, canonicalCommandSchema,
  type AliasMutationResult, type AliasSnapshot,
} from '../../shared/schemas/alias.js';
import { revisionSchema } from '../../shared/schemas/index.js';
import { AppError } from '../errors.js';
import { JsonDocument, type JsonStorage } from '../storage.js';

export { aliasMetadata } from './metadata.js';
export { registerAliasActions } from './module-actions.js';

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
    for (const [command, aliases] of Object.entries(this.file.snapshot().aliases)) {
      if (aliases.includes(parsed.data)) return command;
    }
    return undefined;
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
      if (remove) {
        const aliases = candidate.aliases[target.data]!.filter(value => value !== name.data);
        if (aliases.length) candidate.aliases[target.data] = aliases;
        else delete candidate.aliases[target.data];
      } else {
        const aliases = Object.hasOwn(candidate.aliases, target.data) ? candidate.aliases[target.data]! : [];
        candidate.aliases[target.data] = [...aliases, name.data];
      }
    }, { revision, signal, preflight: current => {
      if (!remove && this.commands.has(name.data)) throw new AppError('CONFLICT', ['alias']);
      const existing = Object.entries(current.aliases).find(([, aliases]) => aliases.includes(name.data))?.[0];
      if (remove) {
        if (existing !== target.data) throw new AppError('NOT_FOUND');
      } else {
        if (existing === target.data) return false;
        if (existing !== undefined) throw new AppError('CONFLICT', ['alias']);
        if ((current.aliases[target.data]?.length ?? 0) >= 8) throw new AppError('INVALID_INPUT', ['alias']);
      }
      return true;
    } });
    return { command: target.data, alias: name.data, changed: result.changed, revision: result.snapshot.revision };
  }
}
