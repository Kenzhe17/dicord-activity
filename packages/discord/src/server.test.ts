import { describe, expect, it, vi } from 'vitest';
import { SessionStore, DiscordOAuthProvider } from './server';
describe('sessions', () => {
  it('expires, revokes and isolates session data', () => {
    let now = 0;
    const store = new SessionStore(() => now, 100);
    const session = store.create({ id: 'dev:p1', name: 'One', avatar: null });
    session.player.name = 'Changed';
    expect(store.get(session.token).player.name).toBe('One');
    now = 101;
    expect(() => store.get(session.token)).toThrow();
    const next = store.create({ id: 'dev:p2', name: 'Two', avatar: null });
    store.revoke(next.token);
    expect(() => store.get(next.token)).toThrow();
  });
});
describe('Discord OAuth boundary', () => {
  it('derives identity only from verified Discord responses', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'test-only-token', token_type: 'Bearer', scope: 'identify' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123456789012345678', username: 'Verified', global_name: null, avatar: null })));
    const result = await new DiscordOAuthProvider('123456789012345679', 'test-only-credential', request).authenticate('test-code');
    expect(result.player.id).toBe('123456789012345678');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toBe('https://discord.com/api/v10/users/@me');
  });
  it('rejects failed exchanges and missing identify permission', async () => {
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(new DiscordOAuthProvider('id', 'test-only', failed).authenticate('bad')).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
    const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ access_token: 'test', token_type: 'Bearer', scope: 'guilds' })));
    await expect(new DiscordOAuthProvider('id', 'test-only', missing).authenticate('bad')).rejects.toThrow('identify');
  });
});
