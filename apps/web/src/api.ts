import { useArcade, storedToken } from './store';
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; } }
export const proxyPrefix = (): string => typeof location === 'undefined' ? '' : location.hostname.endsWith('.discordsays.com') || new URLSearchParams(location.search).has('frame_id') ? '/.proxy' : '';
export const avatarSource = (url: string): string => proxyPrefix() && url.startsWith('https://cdn.discordapp.com/') ? proxyPrefix() + '/discord-cdn/' + url.slice('https://cdn.discordapp.com/'.length) : url;
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useArcade.getState().session?.token ?? storedToken();
  const response = await fetch(proxyPrefix() + '/api' + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...init.headers }, signal: init.signal ?? AbortSignal.timeout(15000) });
  const data: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401) useArcade.getState().setSession(null);
    const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'object' && data.error !== null && 'message' in data.error ? String(data.error.message) : 'Запрос не выполнен';
    throw new ApiError(message, response.status);
  }
  return data as T;
}
export const post = <T>(path: string, body?: unknown): Promise<T> => api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
