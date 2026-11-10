import type { Player } from '@rize/shared';
export interface AuthSession { token: string; expiresAt: number; player: Player }
export interface AuthProvider { authenticate(code: string): Promise<{ player: Player; accessToken: string }> }
