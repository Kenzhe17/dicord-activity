import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError, playerSchema } from '@rize/shared';
import type { Player } from '@rize/shared';
import type { AuthProvider, AuthSession } from './index';

export class SessionStore {
  private readonly sessions = new Map<string, AuthSession>();
  constructor(private readonly now = Date.now, private readonly ttl = 3_600_000, private readonly limit = 10000) {}
  create(player: Player, binding?: { guildId: string; instanceId: string }): AuthSession {
    this.prune();
    if (this.sessions.size >= this.limit) throw new DomainError('RATE_LIMITED', 'Лимит сессий достигнут');
    const session = { token: randomBytes(32).toString('base64url'), player: playerSchema.parse(player), expiresAt: this.now() + this.ttl, ...(binding ? { guildId: binding.guildId, instanceId: binding.instanceId } : {}) };
    this.sessions.set(session.token, session);
    return structuredClone(session);
  }
  get(token: string | undefined): AuthSession {
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.expiresAt <= this.now()) {
      if (token) this.sessions.delete(token);
      throw new DomainError('UNAUTHORIZED', 'Необходима авторизация');
    }
    return structuredClone(session);
  }
  revoke(token: string): void { this.sessions.delete(token); }
  prune(): void { for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(key); }
}
export class DiscordOAuthProvider implements AuthProvider {
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly request: typeof fetch = fetch) {}
  async authenticate(code: string): Promise<{ player: Player; accessToken: string }> {
    const tokenResponse = await this.request('https://discord.com/api/v10/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'authorization_code', code }),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) throw new DomainError('UNAUTHORIZED', 'Discord отклонил код авторизации');
    const token = z.object({ access_token: z.string().min(1), token_type: z.literal('Bearer'), scope: z.string() }).parse(await tokenResponse.json());
    if (!token.scope.split(' ').includes('identify')) throw new DomainError('UNAUTHORIZED', 'Нет разрешения identify');
    const response = await this.request('https://discord.com/api/v10/users/@me', { headers: { authorization: 'Bearer ' + token.access_token }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new DomainError('UNAUTHORIZED', 'Не удалось проверить пользователя Discord');
    const user = z.object({ id: z.string().regex(/^[0-9]{17,20}$/), username: z.string().min(1), global_name: z.string().nullable().optional(), avatar: z.string().regex(/^[a-zA-Z0-9_]+$/).nullable() }).parse(await response.json());
    return { accessToken: token.access_token, player: { id: user.id, username: user.username, name: user.global_name ?? user.username, avatar: user.avatar ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png' : null } };
  }
}
