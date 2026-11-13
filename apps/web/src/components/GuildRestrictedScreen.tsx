import { useState } from 'react';
import { Lock, Copy, Check } from 'lucide-react';
import { Button } from '@rize/ui';
import { ArcadeLogo } from './ArcadeLogo';
import { isDiscordInviteUrl } from '@rize/shared';

/** Full-screen gate shown when the Activity runs outside the allowed guilds
 * (other server, DM, group DM or external browser). */
export function GuildRestrictedScreen({ inviteUrl, guildIds, onInvite }: { inviteUrl: string | null; guildIds: string[] | null; onInvite: (url: string) => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const validInvite = isDiscordInviteUrl(inviteUrl) ? inviteUrl : null;
  async function copyGuild(id: string) {
    try { await navigator.clipboard.writeText(id); setCopied(id); setTimeout(() => setCopied(null), 2000); } catch { /* clipboard unavailable */ }
  }
  return <div className="restricted-shell">
    <div className="restricted-card">
      <ArcadeLogo className="restricted-logo"/>
      <p className="eyebrow">R!Z3 ARCADE</p>
      <h1><Lock size={30}/> Доступ ограничен</h1>
      <p className="restricted-text">r!z3 Arcade доступна только на официальных Discord-серверах r!z3.</p>
      <p className="muted restricted-sub">Присоединяйся к нашему серверу, чтобы играть в Дурака и другие игры вместе с участниками сообщества.</p>
      {validInvite
        ? <Button onClick={() => onInvite(validInvite)}>Присоединиться к серверу</Button>
        : guildIds && guildIds.length > 0
          ? <div className="restricted-guild"><span className="muted">ID сервера:</span>{guildIds.map(id => <span key={id} className="restricted-guild-id"><code>{id}</code><button className="text-button" onClick={() => void copyGuild(id)}>{copied === id ? <><Check size={14}/> Скопировано</> : <><Copy size={14}/> Копировать ID</>}</button></span>)}</div>
          : <p className="muted">Ссылка-приглашение пока не настроена — спросите постоянных участников сообщества r!z3.</p>}
    </div>
  </div>;
}
