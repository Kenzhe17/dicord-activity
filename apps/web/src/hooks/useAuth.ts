import { useState, useEffect } from 'react';
import { initializeDiscordSDK, getAvatarUrl, DiscordAuth, discordSdk } from '../discord/DiscordSDK';

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
        
        // Set timeout for SDK initialization
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Discord SDK timeout')), 10000);
        });
        
        const discordAuth = await Promise.race([
          initializeDiscordSDK(),
          timeoutPromise
        ]) as unknown as DiscordAuth;
        
        console.log('Discord auth successful:', discordAuth);
        setAuth(discordAuth);
      } catch (err) {
        console.error('Discord auth error:', err);
        // For testing: use mock auth if SDK fails
        const mockAuth: DiscordAuth = {
          access_token: 'mock_token',
          user: {
            id: '123456789',
            username: 'TestUser',
            globalName: 'Test User',
            avatar: null,
            discriminator: '0000',
          },
        };
        console.log('Using mock auth for testing:', mockAuth);
        setAuth(mockAuth);
        setError(null); // Clear error so UI loads
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
