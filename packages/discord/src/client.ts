import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { AuthSession } from './index';
export interface ActivityContext {
  instanceId: string; guildId: string | null; channelId: string | null; platform: string;
  participants: { id: string; name: string; avatar: string | null }[]; participantsAvailable: boolean;
}
interface Participant { id: string; username: string; global_name?: string | null | undefined; avatar?: string | null | undefined }
export interface ActivitySdk {
  instanceId: string; guildId: string | null; channelId: string | null; platform: string;
  customId: string | null;
  ready(): Promise<void>;
  commands: {
    authorize(input: { client_id: string; response_type: 'code'; state: string; prompt: 'none'; scope: ('identify' | 'rpc.activities.write')[] }): Promise<{ code: string }>;
    authenticate(input: { access_token: string }): Promise<{ user: { id: string } }>;
    getInstanceConnectedParticipants(): Promise<{ participants: Participant[] }>;
    shareLink(input: { message: string; custom_id?: string }): Promise<{ success: boolean; didCopyLink: boolean; didSendMessage: boolean }>;
    openInviteDialog(): Promise<unknown>;
    setActivity(input: { activity: Record<string, unknown> | null }): Promise<unknown>;
  };
  subscribe(event: 'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', listener: (data: { participants: Participant[] }) => void): Promise<unknown>;
  unsubscribe(event: 'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', listener: (data: { participants: Participant[] }) => void): Promise<unknown>;
}
async function timeout<T>(promise: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Discord не ответил вовремя. Попробуйте войти снова')), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class ActivityClient {
  private listener: ((data: { participants: Participant[] }) => void) | undefined;
  private generation = 0;
  constructor(private readonly clientId: string, private readonly sdk: ActivitySdk) {}
  async login(
    state: string,
    exchange: (code: string, state: string) => Promise<AuthSession & { accessToken: string }>,
    revoke: (token: string) => Promise<void>,
    onContext: (context: ActivityContext) => void,
  ): Promise<AuthSession> {
    await this.dispose();
    const generation = this.generation;
    await timeout(this.sdk.ready());
    const authorizeInput = { client_id: this.clientId, response_type: 'code' as const, state, prompt: 'none' as const };
    let code: string;
    try {
      ({ code } = await timeout(this.sdk.commands.authorize({ ...authorizeInput, scope: ['identify', 'rpc.activities.write'] })));
    } catch {
      // Rich Presence scope denied or unsupported — continue with identify only.
      ({ code } = await timeout(this.sdk.commands.authorize({ ...authorizeInput, scope: ['identify'] })));
    }
    const session = await exchange(code, state);
    try {
      const authenticated = await timeout(this.sdk.commands.authenticate({ access_token: session.accessToken }));
      if (authenticated.user.id !== session.player.id) throw new Error('Discord identity mismatch');
    } catch (error) { await revoke(session.token).catch(() => {}); throw error; }
    const context: ActivityContext = { instanceId: this.sdk.instanceId, guildId: this.sdk.guildId, channelId: this.sdk.channelId, platform: this.sdk.platform, participants: [], participantsAvailable: false };
    const update = ({ participants }: { participants: Participant[] }) => {
      if (generation !== this.generation) return;
      onContext({ ...context, participantsAvailable: true, participants: participants.map(p => ({ id: p.id, name: p.global_name ?? p.username, avatar: p.avatar ? 'https://cdn.discordapp.com/avatars/' + p.id + '/' + p.avatar + '.png' : null })) });
    };
    try {
      update(await timeout(this.sdk.commands.getInstanceConnectedParticipants(), 4000));
      this.listener = update;
      const subscription = this.sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', update);
      void subscription.then(async () => {
        if (generation !== this.generation) await this.sdk.unsubscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', update);
      }).catch(() => {});
      await timeout(subscription, 4000);
    } catch { await this.dispose(); onContext(context); }
    return { token: session.token, expiresAt: session.expiresAt, player: session.player };
  }
  get customId(): string | null { return this.sdk.customId ?? null; }
  async shareLink(input: { message: string; custom_id?: string }): Promise<{ success: boolean; didCopyLink: boolean; didSendMessage: boolean }> {
    return timeout(this.sdk.commands.shareLink(input));
  }
  async openInviteDialog(): Promise<unknown> {
    return timeout(this.sdk.commands.openInviteDialog());
  }
  async setActivity(activity: Record<string, unknown> | null): Promise<unknown> {
    return timeout(this.sdk.commands.setActivity({ activity }));
  }
  async dispose(): Promise<void> {
    this.generation++;
    if (this.listener) {
      const listener = this.listener; this.listener = undefined;
      await timeout(this.sdk.unsubscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', listener), 2000).catch(() => {});
    }
  }
}
let client: ActivityClient | undefined;
export function getActivityClient(clientId: string): ActivityClient {
  client ??= new ActivityClient(clientId, new DiscordSDK(clientId));
  return client;
}
