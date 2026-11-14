import { Crown, WifiOff } from 'lucide-react';
import type { DurakSeatProps } from './contracts';
import { Avatar } from '../Avatar';
import { PlayingCard } from '../PlayingCard';

export function DurakSeat({ view, seat, memberName, avatarUrl, connected, isActor, isDefender, isOut }: DurakSeatProps) {
  const player = view.players[seat];
  const count = player?.count ?? 0;
  const backs = Math.min(5, Math.max(0, count));
  const status = player?.forfeited ? 'Сдался' : isOut ? 'Вышел' : isDefender ? 'Защищается' : isActor ? 'Ходит' : '';
  return <div className={'durak-seat' + (isActor ? ' actor' : '') + (isDefender ? ' defender' : '') + (isOut ? ' out' : '')} role="group" aria-label={memberName + ': ' + count + ' карт'}>
    <div className="durak-seat-id">
      <Avatar src={avatarUrl} name={memberName} className="durak-seat-avatar">{!connected && <WifiOff size={10}/>}</Avatar>
      <div className="durak-seat-meta"><strong>{memberName}</strong>{status && <small>{status}</small>}</div>
      {isOut && <Crown size={12}/>}
    </div>
    <div className="durak-seat-hand" aria-hidden="true">
      {Array.from({ length: backs }, (_, i) => <span key={i} className="durak-seat-card" style={{ transform: 'rotate(' + (i - (backs - 1) / 2) * 8 + 'deg) translateY(' + (i % 2) * -3 + 'px)' }}><PlayingCard back/></span>)}
      <b className="durak-seat-count">{count}</b>
    </div>
  </div>;
}
