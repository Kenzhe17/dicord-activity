import { z } from 'zod';
export const gameIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export const userIdSchema = z.string().regex(/^(?:[0-9]{17,20}|dev:[a-z0-9-]{1,32})$/);
export const playerSchema = z.object({ id: userIdSchema, name: z.string().trim().min(1).max(80), username: z.string().max(80).optional(), avatar: z.url().nullable() });
export type Player = z.infer<typeof playerSchema>;
export const preferencesSchema = z.object({ reducedMotion: z.boolean().default(false), compactCards: z.boolean().default(false) }).strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const gameInfoSchema = z.object({
  id: gameIdSchema, name: z.string(), description: z.string(),
  minPlayers: z.number().int().min(2), maxPlayers: z.number().int().max(32),
  status: z.enum(['planned', 'ready']), modes: z.array(z.string()),
});
export type GameInfo = z.infer<typeof gameInfoSchema>;
export const createRoomSchema = z.object({ gameId: gameIdSchema, name: z.string().trim().min(1).max(64), visibility: z.enum(['public', 'private']), settings: z.unknown().default({}) }).strict();
export const actionEnvelopeSchema = z.object({
  protocol: z.literal(1), roomId: z.uuid(), matchId: z.uuid(),
  requestId: z.uuid(), expectedVersion: z.number().int().nonnegative(), action: z.unknown(),
}).strict();
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;
export type ErrorCode = 'INVALID_INPUT' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'GUILD_RESTRICTED' | 'NOT_FOUND' | 'CONFLICT' | 'GAME_UNAVAILABLE' | 'RATE_LIMITED';
export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = 'DomainError'; }
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };
/** Only genuine Discord invite links may be offered as the "join server" CTA. */
export const discordInviteUrlSchema = z.string().regex(/^https:\/\/(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite|discordapp\.com\/servers)\/[A-Za-z0-9-]{1,64}\/?$/);
export const isDiscordInviteUrl = (value: string | null | undefined): value is string => !!value && discordInviteUrlSchema.safeParse(value).success;
export const roomViewSchema = z.object({
  id: z.string(), name: z.string(), gameId: z.string(), hostId: z.string(), visibility: z.enum(['public', 'private']),
  members: z.array(z.object({ player: playerSchema, ready: z.boolean(), connected: z.boolean().optional() })),
  maxPlayers: z.number().int(), version: z.number().int(), settings: z.unknown(),
  phase: z.enum(['waiting', 'playing']).optional(), matchId: z.string().nullable().optional(),
});
export type RoomView = z.infer<typeof roomViewSchema>;
export type RoomMember = RoomView['members'][number];
export interface RoomSummary { id: string; name: string; gameId: string; players: number; maxPlayers: number }
export interface MatchView { matchId: string; roomId: string; gameId: string; status: string; version: number; state: unknown; result: { winners: readonly string[]; losers: readonly string[]; draw: boolean } | null; createdAt?: string; finishedAt?: string | undefined; stakes?: { perPlayer: number; pool: number; settlement: string; payouts: { playerId: string; amount: number; status: string; overflow?: number | undefined }[] } | null | undefined }
export interface Profile { player: Player; joinedAt: string; statistics: { gameId: string; played: number; wins: number; losses: number; draws: number; rating: number }[] }
export interface HistoryEntry { id: string; gameId: string; finishedAt: string | null; outcome: string | null; ratingDelta: number | null }
export interface RankingEntry { place: number; player: Player; rating: number; wins: number; played: number }
export interface ServerToClientEvents {
  'room:state': (room: RoomView) => void;
  'room:closed': (data: { roomId: string }) => void;
  'match:state': (match: MatchView) => void;
}
export interface ClientToServerEvents {
  'room:subscribe': (input: { roomId: string }, ack: (reply: Reply<RoomView>) => void) => void;
  'match:action': (input: ActionEnvelope, ack: (reply: Reply<MatchView>) => void) => void;
}
