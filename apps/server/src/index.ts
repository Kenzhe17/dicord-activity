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

// Serve static files from frontend build in production
if (process.env.NODE_ENV === 'production') {
  const frontendDistPath = path.join(__dirname, '../../web/dist');
  console.log('Serving static files from:', frontendDistPath);
  console.log('Directory exists:', fs.existsSync(frontendDistPath));
  
  app.use(express.static(frontendDistPath, { fallthrough: true }));

  // Inject config into index.html
  app.get('/', (req, res) => {
    const indexPath = path.join(frontendDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      let html = fs.readFileSync(indexPath, 'utf-8');
      
      // Build server URL from request
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      
      // Inject Discord config into HTML
      const configScript = `
        <script>
          window.__DISCORD_CONFIG = {
            clientId: '${process.env.DISCORD_CLIENT_ID || '1566376251185168394'}',
            serverUrl: '${process.env.CORS_ORIGIN || serverUrl}'
          };
        </script>
      `;
      
      // Insert before closing head tag
      html = html.replace('</head>', configScript + '</head>');
      
      res.send(html);
    } else {
      res.status(404).send('index.html not found');
    }
  });

  // Serve index.html for all other routes (SPA routing)
  app.get('*', (req, res) => {
    const indexPath = path.join(frontendDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      let html = fs.readFileSync(indexPath, 'utf-8');
      
      // Build server URL from request
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      
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

    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
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
        redirect_uri: config.discord.redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      return res.status(400).json({ error: 'Failed to exchange code for token' });
    }

    const tokenData = await tokenResponse.json();
    res.json(tokenData);
  } catch (error) {
    console.error('OAuth error:', error);
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
    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    const user = await authenticateSocket(token);
    if (!user) {
      return next(new Error('Invalid authentication token'));
    }

    socket.data.user = user;
    next();
  } catch (error) {
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
