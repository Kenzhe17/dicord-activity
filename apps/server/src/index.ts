import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { setupSocketIO } from './sockets/socketHandler';
import { authenticateSocket } from './middleware/auth';
import { RoomManager } from './rooms/RoomManager';
import { getOrCreateUser, updateBalance, checkPoolConnection } from './db/postgres';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration to allow Discord Activity domains
app.use(cors({
  origin: (origin, callback) => {
    // Allow all origins for development/testing
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // Allow specific origins
    const allowedOrigins = [
      config.corsOrigin,
      'https://*.discordsays.com',
      'https://*.discord.com',
      'https://*.discord.gg',
    ];
    
    // If origin is allowed
    if (!origin || allowedOrigins.includes('*') || origin === config.corsOrigin) {
      return callback(null, true);
    }
    
    // Allow discordsays.com (Discord Activity embedded domain)
    if (origin.includes('discordsays.com')) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// API routes - MUST be defined before static files
// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeRooms: RoomManager.getActiveRoomCount(),
    totalPlayers: RoomManager.getTotalPlayerCount(),
  });
});

// Discord OAuth callback endpoint
app.post('/api/auth/discord/token', async (req, res) => {
  try {
    const { code } = req.body;

    console.log('[OAuth] Request received, code present:', !!code);

    if (!code) {
      console.log('[OAuth] Error: Code is required');
      return res.status(400).json({ error: 'Code is required' });
    }

    console.log('[OAuth] Client ID:', config.discord.clientId);
    console.log('[OAuth] Client Secret present:', !!config.discord.clientSecret);
    console.log('[OAuth] Redirect URI:', config.discord.redirectUri);

    // For Discord Embedded Apps, use a valid redirect_uri
    // The redirect_uri must match what's configured in Discord Developer Portal
    // For Activities, this is typically the Activity's URL or a special Discord URL
    // Ensure trailing slash for valid URL format
    let redirectUri = config.discord.redirectUri || 'https://discord.com/';
    if (!redirectUri.endsWith('/')) {
      redirectUri += '/';
    }

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    console.log('[OAuth] Discord API response status:', tokenResponse.status);

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.log('[OAuth] Discord API error:', errorText);
      return res.status(400).json({ error: 'Failed to exchange code for token', details: errorText });
    }

    const tokenData = await tokenResponse.json();
    console.log('[OAuth] Token exchange successful');
    res.json(tokenData);
  } catch (error) {
    console.error('[OAuth] Exception:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User info endpoint
app.get('/api/auth/discord/user', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header missing' });
    }

    const token = authHeader.replace('Bearer ', '');
    const userInfo = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!userInfo.ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userData = await userInfo.json();
    res.json(userData);
  } catch (error) {
    console.error('User info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public rooms endpoint
app.get('/api/rooms/public', (req, res) => {
  const rooms = RoomManager.getPublicRooms();
  res.json({ rooms });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    activeRooms: RoomManager.getActiveRoomCount(),
    totalPlayers: RoomManager.getTotalPlayerCount(),
  });
});

// User balance endpoint
app.get('/api/user/balance', async (req, res) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const user = await getOrCreateUser(userId);
    res.json({ user_id: user.user_id, balance: user.balance });
  } catch (error) {
    console.error('Balance endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update balance endpoint
app.post('/api/user/balance', async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    if (!user_id || amount === undefined) {
      return res.status(400).json({ error: 'user_id and amount are required' });
    }

    const user = await updateBalance(user_id, amount);
    res.json({ user_id: user.user_id, balance: user.balance });
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Database health check
app.get('/api/db/health', async (req, res) => {
  const isHealthy = await checkPoolConnection();
  res.json({ healthy: isHealthy });
});

// Debug endpoint to check config
app.get('/api/debug/config', (req, res) => {
  // Force HTTPS for Railway (behind proxy)
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : (process.env.NODE_ENV === 'production' ? 'https' : req.protocol);
  res.json({
    clientId: process.env.DISCORD_CLIENT_ID,
    corsOrigin: process.env.CORS_ORIGIN,
    serverUrl: `${protocol}://${req.get('host')}`,
  });
});

// Serve static files from frontend build in production (MUST be after API routes)
if (process.env.NODE_ENV === 'production') {
  const frontendDistPath = path.join(__dirname, '../../web/dist');
  console.log('Serving static files from:', frontendDistPath);
  console.log('Directory exists:', fs.existsSync(frontendDistPath));
  
  app.use(express.static(frontendDistPath, { fallthrough: true }));

  // Inject config into index.html
  app.get('/', (req, res) => {
    console.log(`[ROOT ROUTE] Request received: ${req.url}, Host: ${req.get('host')}`);
    
    const indexPath = path.join(frontendDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      let html = fs.readFileSync(indexPath, 'utf-8');
      
      // Build server URL from request (force HTTPS in production)
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : (process.env.NODE_ENV === 'production' ? 'https' : req.protocol);
      const serverUrl = `${protocol}://${req.get('host')}`;
      
      const clientId = process.env.DISCORD_CLIENT_ID || '1566376251185168394';
      const serverUrlValue = process.env.CORS_ORIGIN || serverUrl;
      
      console.log(`[CONFIG INJECTION] Client ID: ${clientId}, Server URL: ${serverUrlValue}`);
      
      // Inject Discord config into HTML
      const configScript = `
        <script>
          window.__DISCORD_CONFIG = {
            clientId: '${clientId}',
            serverUrl: '${serverUrlValue}'
          };
          console.log('[CONFIG] Runtime config injected:', window.__DISCORD_CONFIG);
        </script>
      `;
      
      // Insert before closing head tag
      html = html.replace('</head>', configScript + '</head>');
      
      res.send(html);
    } else {
      console.log(`[ROOT ROUTE] index.html not found at ${indexPath}`);
      res.status(404).send('index.html not found');
    }
  });

  // Serve index.html for all other routes (SPA routing)
  app.get('*', (req, res) => {
    const indexPath = path.join(frontendDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      let html = fs.readFileSync(indexPath, 'utf-8');
      
      // Build server URL from request (force HTTPS in production)
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : (process.env.NODE_ENV === 'production' ? 'https' : req.protocol);
      const serverUrl = `${protocol}://${req.get('host')}`;
      
      const configScript = `
        <script>
          window.__DISCORD_CONFIG = {
            clientId: '${process.env.DISCORD_CLIENT_ID || '1566376251185168394'}',
            serverUrl: '${process.env.CORS_ORIGIN || serverUrl}'
          };
        </script>
      `;
      
      html = html.replace('</head>', configScript + '</head>');
      
      res.send(html);
    } else {
      res.status(404).send('index.html not found');
    }
  });
}

const io = new Server(httpServer, {
  cors: {
    origin: config.corsOrigin,
    credentials: true,
  },
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    const username = socket.handshake.auth.username;
    const globalName = socket.handshake.auth.globalName;

    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    const user = await authenticateSocket(token, username, globalName);
    if (!user) {
      return next(new Error('Invalid authentication token'));
    }

    socket.data.user = user;
    console.log(`[SOCKET] User authenticated: ${user.id} (${user.username}, balance: ${user.balance})`);
    next();
  } catch (error) {
    console.error('[SOCKET] Authentication error:', error);
    next(new Error('Authentication failed'));
  }
});

setupSocketIO(io);

// Cleanup inactive rooms every hour
setInterval(() => {
  RoomManager.cleanupInactiveRooms();
}, 60 * 60 * 1000);

const PORT = config.port;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS origin: ${config.corsOrigin}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
