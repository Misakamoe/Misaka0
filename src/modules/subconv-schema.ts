import { z } from 'zod';
import { revisionSchema } from '../../shared/schemas/index.js';
import { subconvSettingsSchema } from '../../shared/schemas/subconv.js';

export const subconvUpdateSchema = z.strictObject({ revision: revisionSchema, settings: subconvSettingsSchema });
export const subconvResetSchema = z.strictObject({ revision: revisionSchema });
