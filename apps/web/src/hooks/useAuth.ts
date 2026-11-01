import { useState, useEffect } from 'react';
import { initializeDiscordSDK, getAvatarUrl, DiscordAuth } from '../discord/DiscordSDK';

export function useAuth() {
  const [auth, setAuth] = useState<DiscordAuth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDiscord, setIsDiscord] = useState(false);

  useEffect(() => {
    // Check if running inside Discord
    const urlParams = new URLSearchParams(window.location.search);
    const hasFrameId = urlParams.has('frame_id');
    setIsDiscord(hasFrameId);

    async function authenticate() {
      try {
        setLoading(true);
        console.log('Initializing Discord SDK...');
        
        // Use build-time constants
        const clientId = __DISCORD_CLIENT_ID__;
        const serverUrl = __SERVER_URL__;
        
        console.log('Client ID:', clientId);
        console.log('Server URL:', serverUrl);
        
        // Set runtime config for other modules
        // @ts-ignore
        window.__DISCORD_CONFIG = { clientId, serverUrl };
        
        const discordAuth = await initializeDiscordSDK();
        console.log('Discord auth successful:', discordAuth);
        setAuth(discordAuth);
      } catch (err) {
        console.error('Discord auth error:', err);
        setError(err instanceof Error ? err.message : 'Authentication failed');
      } finally {
        setLoading(false);
      }
    }

    if (hasFrameId) {
      authenticate();
    } else {
      setLoading(false);
      setError('Это приложение должно запускаться внутри Discord Activity');
    }
  }, []);

  return { auth, loading, error, getAvatarUrl, isDiscord };
}
