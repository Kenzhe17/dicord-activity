import { create } from 'zustand';
import type { AuthSession } from '@rize/discord';
import type { RoomView, MatchView, Preferences } from '@rize/shared';
const tokenKey = 'rize.arcade.session';
export function storedToken(): string | null { try { return sessionStorage.getItem(tokenKey); } catch { return null; } }
interface AppState {
  session: AuthSession | null; room: RoomView | null; match: MatchView | null; preferences: Preferences;
  setSession: (session: AuthSession | null) => void; setRoom: (room: RoomView | null) => void; setMatch: (match: MatchView | null) => void; setPreferences: (preferences: Preferences) => void;
}
export const useArcade = create<AppState>(set => ({
  session: null, room: null, match: null, preferences: { reducedMotion: false, compactCards: false },
  setSession: session => {
    try { if (session) sessionStorage.setItem(tokenKey, session.token); else sessionStorage.removeItem(tokenKey); } catch { /* Session remains usable in memory when browser storage is unavailable. */ }
    set(session ? { session } : { session: null, room: null, match: null });
  },
  setRoom: room => set(state => room && state.room?.id === room.id && state.room.version > room.version ? {} : { room }),
  setMatch: match => set(state => match && state.match?.matchId === match.matchId && state.match.version > match.version ? {} : { match }),
  setPreferences: preferences => set({ preferences }),
}));
