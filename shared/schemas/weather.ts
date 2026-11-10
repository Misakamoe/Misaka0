import { z } from 'zod';
import { revisionSchema } from './index.js';

export const weatherLocationSchema = z.strictObject({
  id: z.string().max(100), name: z.string().max(128), label: z.string().min(1).max(300),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  country: z.string().max(80), timezone: z.string().max(64).optional(),
});
export const weatherSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(120).optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
}).refine(input => input.query ? input.latitude === undefined && input.longitude === undefined : input.latitude !== undefined && input.longitude !== undefined);
export const weatherSearchSchema = z.strictObject({ locations: z.array(weatherLocationSchema).max(10) });
export const weatherQueryInputSchema = z.strictObject({ location: weatherLocationSchema, mode: z.enum(['current', 'forecast']).default('current'), days: z.number().int().min(1).max(7).default(3) });
export const weatherDefaultSchema = z.strictObject({ revision: revisionSchema, location: weatherLocationSchema.nullable() });
export const weatherDefaultInputSchema = z.strictObject({ revision: revisionSchema, location: weatherLocationSchema.nullable() });
const temperature = z.number().min(-150).max(100).nullable();
export const weatherResultSchema = z.strictObject({
  location: weatherLocationSchema, provider: z.enum(['qweather', 'openweather', 'open-meteo']), fetchedAt: z.iso.datetime(),
  observedAt: z.iso.datetime().nullable(), description: z.string().max(200), code: z.number().int().nullable(),
  temperature, feelsLike: temperature, humidity: z.number().min(0).max(100).nullable(),
  windKph: z.number().min(0).max(1000).nullable(), precipitation: z.number().min(0).nullable(),
  days: z.array(z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), min: temperature, max: temperature,
    description: z.string().max(200), code: z.number().int().nullable(), precipitation: z.number().min(0).nullable(), probability: z.number().min(0).max(100).nullable(),
  })).max(7),
  attributions: z.array(z.url()).min(1).max(8), model: z.boolean(), fallback: z.boolean(),
});
export type WeatherLocation = z.infer<typeof weatherLocationSchema>;
export type WeatherSearchInput = z.infer<typeof weatherSearchInputSchema>;
export type WeatherQueryInput = z.infer<typeof weatherQueryInputSchema>;
export type WeatherResult = z.infer<typeof weatherResultSchema>;
