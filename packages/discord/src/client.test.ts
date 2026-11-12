import { describe, expect, it, vi } from 'vitest';
import { ActivityClient } from './client';
import type { ActivitySdk, ActivityContext } from './client';
const player = { id: '123456789012345678', name: 'Verified', avatar: null };
function fixture() {
  const sdk: ActivitySdk = {
    instanceId: 'instance', guildId: 'guild', channelId: 'channel', platform: 'desktop', customId: null,
    ready: vi.fn(async () => {}),
    commands: {
      authorize: vi.fn(async () => ({ code: 'test-code' })),
      authenticate: vi.fn(async () => ({ user: { id: player.id } })),
      getInstanceConnectedParticipants: vi.fn(async () => ({ participants: [{ id: player.id, username: 'Participant' }] })),
      shareLink: vi.fn(async () => ({ success: true, didCopyLink: false, didSendMessage: true })),
      openInviteDialog: vi.fn(async () => ({})),
      openExternalLink: vi.fn(async () => ({})),
      setActivity: vi.fn(async () => ({})),
    },
    subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}),
  };
  const exchange = vi.fn(async () => ({ token: 'test-session', expiresAt: 1000, player, accessToken: 'test-discord-token' }));
  return { sdk, exchange, revoke: vi.fn(async () => {}), client: new ActivityClient('client-id', sdk) };
}
describe('Activity integration', () => {
  it('initializes, authorizes, authenticates and observes context without trusting SDK identity', async () => {
    const { sdk, exchange, client, revoke } = fixture();
    const updates: ActivityContext[] = [];
    const session = await client.login('server-nonce', exchange, revoke, c => updates.push(c));
    expect(session.player.id).toBe(player.id);
    expect(session).not.toHaveProperty('accessToken');
    expect(exchange).toHaveBeenCalledWith('test-code', 'server-nonce');
    expect(sdk.commands.authorize).toHaveBeenCalledWith(expect.objectContaining({ state: 'server-nonce', scope: ['identify', 'rpc.activities.write'] }));
    expect(updates[0]).toMatchObject({ instanceId: 'instance', participantsAvailable: true });
    await client.dispose();
    expect(sdk.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('revokes issued session if SDK identity does not match backend verification', async () => {
    const { sdk, exchange, client, revoke } = fixture();
    vi.mocked(sdk.commands.authenticate).mockResolvedValue({ user: { id: 'different' } });
    await expect(client.login('nonce', exchange, revoke, () => {})).rejects.toThrow('identity');
    expect(revoke).toHaveBeenCalledWith('test-session');
  });
  it('allows clients without participants support and unsubscribes before repeated login', async () => {
    const { sdk, exchange, client, revoke } = fixture();
    const updates = vi.fn();
    await client.login('nonce', exchange, revoke, updates);
    vi.mocked(sdk.commands.getInstanceConnectedParticipants).mockRejectedValue(new Error('unsupported'));
    await client.login('new-nonce', exchange, revoke, updates);
    expect(sdk.unsubscribe).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ participantsAvailable: false }));
  });
  it('checkGuild compares the SDK guild after ready and treats missing guild as restricted', async () => {
    const { sdk, client } = fixture();
    expect(await client.checkGuild('guild')).toBe(true);
    sdk.guildId = null;
    expect(await client.checkGuild('guild')).toBe(false);
    sdk.guildId = 'other';
    expect(await client.checkGuild('guild')).toBe(false);
    expect(sdk.ready).toHaveBeenCalled();
  });
  it('openExternalLink forwards the URL to the SDK command', async () => {
    const { sdk, client } = fixture();
    await client.openExternalLink('https://discord.gg/example');
    expect(sdk.commands.openExternalLink).toHaveBeenCalledWith({ url: 'https://discord.gg/example' });
  });
});
