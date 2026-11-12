import { useState } from 'react';
import { Lock, Copy, Check } from 'lucide-react';
import { Button } from '@rize/ui';
import { ArcadeLogo } from './ArcadeLogo';
import { isDiscordInviteUrl } from '@rize/shared';

/** Full-screen gate shown when the Activity runs outside the allowed guild
 * (other server, DM, group DM or external browser). */
export function GuildRestrictedScreen({ inviteUrl, guildId, onInvite }: { inviteUrl: string | null; guildId: string | null; onInvite: (url: string) => void }) {
  const [copied, setCopied] = useState(false);
  const validInvite = isDiscordInviteUrl(inviteUrl) ? inviteUrl : null;
  async function copyGuild() {
    if (!guildId) return;
    try { await navigator.clipboard.writeText(guildId); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard unavailable */ }
  }
  return <div className="restricted-shell">
    <div className="restricted-card">
      <ArcadeLogo className="restricted-logo"/>
      <p className="eyebrow">R!Z3 ARCADE</p>
      <h1><Lock size={30}/> Доступ ограничен</h1>
      <p className="restricted-text">r!z3 Arcade доступна только на официальном Discord-сервере r!z3.</p>
      <p className="muted restricted-sub">Присоединяйся к нашему серверу, чтобы играть в Дурака и другие игры вместе с участниками сообщества.</p>
      {validInvite
        ? <Button onClick={() => onInvite(validInvite)}>Присоединиться к серверу</Button>
        : guildId
          ? <div className="restricted-guild"><span className="muted">ID сервера:</span><code>{guildId}</code><button className="text-button" onClick={() => void copyGuild()}>{copied ? <><Check size={14}/> Скопировано</> : <><Copy size={14}/> Копировать ID</>}</button></div>
          : <p className="muted">Ссылка-приглашение пока не настроена — спросите постоянных участников сообщества r!z3.</p>}
    </div>
  </div>;
}
