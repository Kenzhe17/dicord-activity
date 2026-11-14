import type { RoomView } from '@rize/shared';
import type { MafiaAction, MafiaView, MafiaRole, MafiaPace, MafiaChatChannel, MafiaChatMessage, MafiaFeedItem, MafiaSeatStats } from '@rize/mafia';

export type { MafiaAction, MafiaView, MafiaRole, MafiaPace, MafiaChatChannel, MafiaChatMessage, MafiaFeedItem, MafiaSeatStats };
export type MafiaSeat = MafiaView['players'][number];
export type MafiaYou = MafiaView['you'];

export function seatOf(view: MafiaView, playerId: string): number {
  return view.players.find(p => p.id === playerId)?.seat ?? -1;
}

export function memberName(room: RoomView, id: string | null | undefined): string {
  return (id ? room.members.find(m => m.player.id === id)?.player.name : undefined) ?? 'Игрок';
}

export const PACE_LABEL: Record<MafiaPace, string> = { classic: 'Классика', short: 'Short', blitz: 'Blitz' };

export const PHASE_LABEL: Record<MafiaView['phase'], string> = {
  reveal: 'Роли розданы', night: 'Ночь', dawn: 'Рассвет',
  discussion: 'День', voting: 'Голосование', runoff: 'Повторное голосование', finished: 'Партия завершена',
};

export const ROLE_LABEL: Record<MafiaRole, string> = {
  mafia: 'Мафия', town: 'Мирный житель', sheriff: 'Комиссар', doctor: 'Доктор',
};
export const ROLE_TEAM: Record<MafiaRole, string> = {
  mafia: 'Команда мафии', town: 'Город', sheriff: 'Город', doctor: 'Город',
};
export const ROLE_HINT: Record<MafiaRole, string> = {
  mafia: 'Каждую ночь мафия выбирает одну цель. Побеждаете, когда мафии не меньше половины живых.',
  town: 'Вычисляйте мафию голосованием. Не голосуйте за себя и не подсказывайте роли голосом.',
  sheriff: 'Каждую ночь проверяйте одного игрока — результат видите только вы. Не проверяйте себя.',
  doctor: 'Каждую ночь лечите одного игрока. Одного и того же нельзя лечить две ночи подряд.',
};
