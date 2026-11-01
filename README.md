# r!z3 Arcade

Multiplayer Discord Activity with three games: Durak, UNO, and Mafia.

## Project Structure

```
rize3-arcade/
├── apps/
│   ├── web/          # React + Vite frontend
│   └── server/       # Express + Socket.IO backend
├── packages/
│   └── shared/       # Shared TypeScript types and schemas
├── assets/           # Game assets (cards, backgrounds, icons, sounds)
├── docs/             # Documentation
└── third_party/      # Third-party licenses
```

## Tech Stack

### Frontend
- React 18
- TypeScript
- Vite
- Tailwind CSS
- Framer Motion
- Lucide React
- Discord Embedded App SDK
- Socket.IO Client

### Backend
- Node.js
- TypeScript
- Express
- Socket.IO
- Zod (validation)

### Infrastructure
- npm workspaces (monorepo)
- Docker
- Railway (deployment)

## Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- Discord Application with Activity features enabled

## Setup

### 1. Clone the repository

```bash
git clone <repository-url>
cd discord-activity
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in your Discord credentials:

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env
```

Required environment variables:

**Root `.env`:**
- `DISCORD_CLIENT_ID` - Your Discord Application Client ID
- `DISCORD_CLIENT_SECRET` - Your Discord Application Client Secret
- `DISCORD_REDIRECT_URI` - Your app's URL (e.g., https://your-app.railway.app)
- `PORT` - Server port (default: 3001)
- `CORS_ORIGIN` - Frontend URL

**`apps/web/.env`:**
- `VITE_DISCORD_CLIENT_ID` - Your Discord Application Client ID
- `VITE_SERVER_URL` - Backend URL (e.g., http://localhost:3001 for development)

### 4. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Enable "Activity" in the Application settings
4. Add a redirect URI matching your `DISCORD_REDIRECT_URI`
5. Note your Client ID and Client Secret

## Development

### Run both frontend and backend

```bash
npm run dev
```

This starts:
- Frontend on http://localhost:5173
- Backend on http://localhost:3001

### Run only frontend

```bash
npm run dev:web
```

### Run only backend

```bash
npm run dev:server
```

## Building

### Build all packages

```bash
npm run build
```

### Build only frontend

```bash
npm run build:web
```

### Build only backend

```bash
npm run build:server
```

## Deployment to Railway

**Подробная инструкция:** См. [docs/RAILWAY_SETUP.md](./docs/RAILWAY_SETUP.md)

### Краткая инструкция

1. **Настройте Discord Application**
   - Перейдите в [Discord Developer Portal](https://discord.com/developers/applications)
   - Выберите или создайте приложение с ID: `1566376251185168394`
   - Включите **Activity** > **Embedded App SDK**
   - Получите **Client Secret** из раздела **OAuth2** > **General**
   - Добавьте Redirect URI (после деплоя)

2. **Разверните на Railway**
   - Перейдите на https://railway.app
   - Создайте новый проект из GitHub репозитория
   - Настройте environment variables:
     ```
     DISCORD_CLIENT_ID=1566376251185168394
     DISCORD_CLIENT_SECRET=ваш_client_secret
     DISCORD_REDIRECT_URI=https://ваше-имя-app.railway.app
     PORT=3001
     CORS_ORIGIN=https://ваше-имя-app.railway.app
     VITE_DISCORD_CLIENT_ID=1566376251185168394
     VITE_SERVER_URL=https://ваше-имя-app.railway.app
     ```

3. **Обновите Discord Application**
   - Добавьте Railway URL в Redirect URIs
   - В Activity > Application URL введите Railway URL

4. **Тестирование**
   - Установите бота на тестовый сервер
   - Запустите Activity через Discord
   - Протестируйте с несколькими пользователями

## Testing with Discord

### Local Development with Cloudflare Tunnel

For local testing inside Discord:

1. Install Cloudflare Tunnel
2. Create a tunnel to expose localhost:5173 and localhost:3001
3. Update your Discord Application redirect URIs to use the tunnel URL
4. Update environment variables to use the tunnel URL

### Production Testing

1. Deploy to Railway
2. Update Discord Application with Railway URL
3. Test the Activity in Discord

## Stage 1 Features (Current)

- Discord Embedded App SDK integration
- OAuth2 authentication
- Main menu with game cards
- Room system (create, join, leave)
- Real-time WebSocket synchronization
- Player ready status
- Game start functionality
- Docker deployment support

## Future Stages

- **Stage 2:** Durak game implementation
- **Stage 3:** UNO game implementation
- **Stage 4:** Mafia game implementation
- **Stage 5:** Polish, animations, sounds

## Architecture Decisions

### Monorepo with npm workspaces
- Shared types and schemas in `packages/shared`
- Separate frontend and backend workspaces
- Easy dependency management

### Socket.IO for real-time communication
- Bi-directional events
- Automatic reconnection
- Room-based messaging

### Server-side game state
- All game logic validated on backend
- Individual player views (no cheating)
- Secure room management

### Discord Embedded App SDK
- Native Discord integration
- OAuth2 authorization code flow
- No secrets on frontend

## Security

- Client secrets never exposed to frontend
- All Socket.IO connections authenticated
- Game state validated server-side
- Private information (cards, roles) never sent to wrong clients
- Rate limiting and input validation with Zod

## License

MIT

## Third-Party Notices

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for licenses of third-party code and assets.
