import { afterEach, describe, expect, it, vi } from 'vitest';
import { EconomyBridge } from './economy';

afterEach(() => vi.unstubAllGlobals());

const bridge = () => new EconomyBridge('https://bridge.test', 'tok-'.padEnd(40, 'x'), '1196165488565289012');

describe('EconomyBridge.getBalance classification', () => {
  it('returns classified failures instead of a fake balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));
    expect(await bridge().getBalance('123456789012345678')).toEqual({ ok: false, reason: 'unauthorized' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await bridge().getBalance('123456789012345678')).toEqual({ ok: false, reason: 'unavailable' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await bridge().getBalance('123456789012345678')).toEqual({ ok: false, reason: 'invalid_response' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"rate_limited"}', { status: 429 })));
    expect(await bridge().getBalance('123456789012345678')).toEqual({ ok: false, reason: 'rate_limited' });
    expect(await bridge().getBalance('not-a-snowflake')).toEqual({ ok: false, reason: 'bad_request' });
  });
  it('passes through balance, wallet existence and writes flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ balance: 250, exists: true, writes_enabled: false }), { status: 200 })));
    expect(await bridge().getBalance('123456789012345678')).toEqual({ ok: true, balance: 250, exists: true, writesEnabled: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ balance: null, exists: false }), { status: 200 })));
    expect(await bridge().getBalance('123456789012345678')).toEqual({ ok: true, balance: null, exists: false, writesEnabled: true });
  });
});
