import { useState, useEffect } from 'react';
import { initializeDiscordSDK, getAvatarUrl, DiscordAuth } from '../discord/DiscordSDK';

export function useAuth() {
  const [auth, setAuth] = useState<DiscordAuth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function authenticate() {
      try {
        setLoading(true);
        const discordAuth = await initializeDiscordSDK();
        setAuth(discordAuth);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Authentication failed');
      } finally {
        setLoading(false);
      }
    }

    authenticate();
  }, []);

  return { auth, loading, error, getAvatarUrl };
}
