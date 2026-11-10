import { describe, expect, it } from 'vitest';
import { createProviderJson } from '../src/modules/provider-http.js';

describe('credentialed provider origin boundaries', () => {
  it.each([
    'http://api.example.com/data?key=TEST_SECRET', 'https://api.example.com.evil.test/data?key=TEST_SECRET',
    'https://evil.test/api.example.com', 'https://user:TEST_SECRET@api.example.com/data', 'https://api.example.com:8443/data',
    'file:///api.example.com/TEST_SECRET',
  ])('rejects untrusted URL %s without exposing credential material', async input => {
    const request = createProviderJson(['api.example.com']);
    const failure = await request(new URL(input), new AbortController().signal, { 'X-Api-Key': 'TEST_SECRET' }).catch(error => error);
    expect(failure).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(String(failure)).not.toContain('TEST_SECRET');
    expect(String(failure)).not.toContain(input);
  });
  it('rejects an already cancelled operation before DNS or HTTP work', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createProviderJson(['api.example.com'])(new URL('https://api.example.com/data'), controller.signal)).rejects.toThrow('CANCELLED');
  });
});
