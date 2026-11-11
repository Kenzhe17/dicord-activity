import type { RoomView } from '@rize/shared';

export interface JoinAvailability {
  canJoin: boolean;
  needsInvite: boolean;
  reason: string | null;
}

// Whether `viewerId` could join this room right now. The backend remains the
// authority — this only drives UI affordances and never grants access.
export function getRoomJoinAvailability(room: RoomView, viewerId: string): JoinAvailability {
  const needsInvite = room.visibility === 'private';
  if (room.phase === 'playing') return { canJoin: false, needsInvite, reason: 'Партия уже идёт' };
  if (room.members.length >= room.maxPlayers) return { canJoin: false, needsInvite, reason: 'Комната заполнена' };
  if (room.members.some(member => member.player.id === viewerId)) return { canJoin: false, needsInvite, reason: 'Вы уже в комнате' };
  return { canJoin: true, needsInvite, reason: null };
}

export function parseRoomInviteCode(code: string): { roomId: string; inviteToken: string } | null {
  const match = /^([0-9a-fA-F-]{36}):([A-Za-z0-9_-]{16,})$/.exec(code.trim());
  return match ? { roomId: match[1]!, inviteToken: match[2]! } : null;
}
