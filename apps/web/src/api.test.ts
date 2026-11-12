import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarSource, proxyPrefix } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('Discord proxy helpers', () => {
  it('returns an empty prefix outside Discord Activities', () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1', search: '' });
    expect(proxyPrefix()).toBe('');
    expect(avatarSource('https://cdn.discordapp.com/avatars/1/abc.png')).toBe('https://cdn.discordapp.com/avatars/1/abc.png');
  });
  it('routes Discord CDN avatars through /.proxy inside Activities', () => {
    vi.stubGlobal('location', { hostname: '12345.discordsays.com', search: '' });
    expect(proxyPrefix()).toBe('/.proxy');
    expect(avatarSource('https://cdn.discordapp.com/avatars/123456789012345678/' + 'a'.repeat(32) + '.png')).toBe('/.proxy/discord-cdn/avatars/123456789012345678/' + 'a'.repeat(32) + '.png');
    expect(avatarSource('https://cdn.discordapp.com/embed/avatars/0.png')).toBe('/.proxy/discord-cdn/embed/avatars/0.png');
  });
  it('leaves non-Discord hosts and frame_id detection intact', () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1', search: '?frame_id=abc' });
    expect(proxyPrefix()).toBe('/.proxy');
    vi.stubGlobal('location', { hostname: '127.0.0.1', search: '' });
    expect(avatarSource('https://evil.example/avatars/1/x.png')).toBe('https://evil.example/avatars/1/x.png');
  });
});
