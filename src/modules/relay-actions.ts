import { emptyInputSchema } from '../../shared/schemas/index.js';
import {
  relayCancelResultSchema, relayContactInputSchema, relayContactListSchema, relayContactSchema, relayContactStatusSchema,
  relayListInputSchema, relayMutationInputSchema, relayOwnerContactSchema, relaySendResultSchema,
  relaySettingsInputSchema, relaySettingsSchema, relaySourceInputSchema,
} from '../../shared/schemas/relay.js';
import type { ActionExecutor } from '../actions.js';
import type { RelayService } from './relay.js';

export function registerRelayActions(executor: Pick<ActionExecutor, 'register'>, service: RelayService): void {
  const common = { permission: 'self', scopes: ['private'], sources: ['telegram'], aiVisible: false, timeoutMs: 30_000 } as const;
  const owner = { ...common, permission: 'superadmin' } as const;
  executor.register({ ...owner, id: 'relay.settings.get', input: emptyInputSchema, output: relaySettingsSchema, effect: 'read',
    execute: (_input, context) => service.settings(context) });
  executor.register({ ...owner, id: 'relay.settings.set', input: relaySettingsInputSchema, output: relaySettingsSchema, effect: 'personal_write',
    execute: (input, context) => service.configure(context, input) });
  executor.register({ ...owner, id: 'relay.contacts.list', input: relayListInputSchema, output: relayContactListSchema, effect: 'read',
    execute: (input, context) => service.list(context, input.page) });
  executor.register({ ...owner, id: 'relay.contacts.get', input: relayContactInputSchema, output: relayOwnerContactSchema, effect: 'read',
    execute: (input, context) => service.get(context, input.id) });
  executor.register({ ...common, id: 'relay.contact.status', input: emptyInputSchema, output: relayContactStatusSchema, effect: 'read',
    execute: (_input, context) => service.status(context) });
  executor.register({ ...common, id: 'relay.contact.request', input: relaySourceInputSchema, output: relayContactSchema, effect: 'personal_write',
    execute: (input, context) => service.request(context, input.source) });
  for (const operation of ['accept', 'decline', 'close', 'block'] as const) {
    executor.register({ ...(operation === 'close' ? common : owner), id: `relay.contact.${operation}`,
      input: relayMutationInputSchema, output: relayContactSchema, effect: 'personal_write',
      execute: (input, context) => service.change(context, operation, input) });
  }
  executor.register({ ...common, id: 'relay.contact.resume', input: relayMutationInputSchema, output: relayContactSchema, effect: 'personal_write',
    execute: (input, context) => service.resume(context, input) });
  executor.register({ ...common, id: 'relay.send', input: relaySourceInputSchema, output: relaySendResultSchema, effect: 'personal_write',
    execute: (input, context) => service.send(context, input.source) });
  executor.register({ ...common, id: 'relay.cancel', input: emptyInputSchema, output: relayCancelResultSchema, effect: 'personal_write',
    execute: (_input, context) => service.cancel(context) });
}
