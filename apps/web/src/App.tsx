import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from './hooks/useAuth';
import { initializeSocket, disconnectSocket, getSocket } from './services/socket';
import { Room, GameType } from '@rize3-arcade/shared/dist/index.js';
import { GameCard } from './components/GameCard';
import { RoomList } from './components/RoomList';
import { CreateRoomModal } from './components/CreateRoomModal';
import { JoinRoomModal } from './components/JoinRoomModal';
import { RoomLobby } from './components/RoomLobby';
import { Loader2, Users, Gamepad2 } from 'lucide-react';

function App() {
  const { auth, loading, error, getAvatarUrl, isDiscord } = useAuth();
  const [currentView, setCurrentView] = useState<'menu' | 'create-room' | 'join-room' | 'lobby'>('menu');
  const [selectedGame, setSelectedGame] = useState<GameType | null>(null);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [stats, setStats] = useState({ activeRooms: 0, totalPlayers: 0 });
  const [balance, setBalance] = useState<number>(0);

  useEffect(() => {
    if (auth) {
      // Use user.id as the token (Discord user_id), not access_token
      const socket = initializeSocket(auth.user.id, auth.user.username, auth.user.globalName || undefined);

      socket.on('room_created', (data: any) => {
        setCurrentRoom(data.room);
        setCurrentView('lobby');
      });

      socket.on('room_updated', (data: any) => {
        setCurrentRoom(data.room);
      });

      socket.on('player_joined', (data: any) => {
        setCurrentRoom(data.room);
        // If we just joined by code, show lobby
        if (currentView === 'join-room') {
          setCurrentView('lobby');
        }
      });

      socket.on('player_left', (data: any) => {
        setCurrentRoom(data.room);
      });

      socket.on('game_started', (data: any) => {
        console.log('Game started:', data);
      });

      socket.on('error', (data: any) => {
        console.error('Socket error:', data);
      });

      fetchStats();

      const interval = setInterval(fetchStats, 30000);

      return () => {
        clearInterval(interval);
        disconnectSocket();
      };
    }
  }, [auth]);

  async function fetchStats() {
    try {
      const serverUrl = __SERVER_URL__ || '';
      const response = await fetch(`${serverUrl}/api/stats`);
      const data = await response.json();
      setStats(data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  }

  async function fetchBalance() {
    try {
      const serverUrl = __SERVER_URL__ || '';
      const response = await fetch(`${serverUrl}/api/user/balance?user_id=${auth.user.id}`);
      const data = await response.json();
      setBalance(data.balance);
    } catch (error) {
      console.error('Failed to fetch balance:', error);
    }
  }

  useEffect(() => {
    if (auth) {
      fetchBalance();
    }
  }, [auth]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-gold mx-auto mb-4" />
          <p className="text-secondary-text">Загрузка...</p>
        </div>
      </div>
    );
  }

  if (!isDiscord) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center max-w-md p-6">
          <Gamepad2 className="w-16 h-16 text-gold mx-auto mb-6" />
          <h1 className="text-2xl font-bold mb-4">r!z3 Arcade</h1>
          <p className="text-secondary-text mb-6">
            Это приложение должно запускаться внутри Discord Activity.
          </p>
          <div className="glass-panel p-4 text-left text-sm">
            <p className="text-gold font-semibold mb-2">Как запустить:</p>
            <ol className="list-decimal list-inside space-y-2 text-secondary-text">
              <li>Откройте Discord</li>
              <li>Перейдите на сервер с ботом</li>
              <li>Запустите Activity r!z3 Arcade</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center max-w-md">
          <p className="text-error mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="btn-gold"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  if (!auth) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="glass-panel m-4 p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <img
              src={getAvatarUrl(auth.user.id, auth.user.avatar)}
              alt={auth.user.username}
              className="w-10 h-10 rounded-full border-2 border-gold"
            />
            <span className="font-semibold">{auth.user.globalName || auth.user.username}</span>
          </div>
          <div className="glass-panel px-4 py-2">
            <span className="text-gold font-bold">Баланс: {balance}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-secondary-text">
          <Users className="w-5 h-5" />
          <span>{stats.totalPlayers} онлайн</span>
        </div>
      </header>

      {/* Main Content */}
      <main className="p-4">
        <AnimatePresence mode="wait">
          {currentView === 'menu' && (
            <motion.div
              key="menu"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              {/* Action Buttons */}
              <div className="flex gap-4 justify-center">
                <button
                  onClick={() => setCurrentView('create-room')}
                  className="btn-gold"
                >
                  Создать комнату
                </button>
                <button
                  onClick={() => setCurrentView('join-room')}
                  className="btn-secondary"
                >
                  Присоединиться
                </button>
              </div>

              {/* Game Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <GameCard
                  game="durak"
                  title="Дурак"
                  description="Классическая карточная игра с режимами подкидной и переводной"
                  players="2-6"
                  onClick={() => {
                    setSelectedGame('durak');
                    setCurrentView('create-room');
                  }}
                />
                <GameCard
                  game="uno"
                  title="UNO"
                  description="В разработке"
                  players="2-10"
                  disabled={true}
                />
                <GameCard
                  game="mafia"
                  title="Мафия"
                  description="В разработке"
                  players="5-12"
                  disabled={true}
                />
              </div>

              {/* Public Rooms */}
              <div>
                <h2 className="text-xl font-bold mb-4">Доступные комнаты ({stats.activeRooms})</h2>
                <RoomList onJoin={(roomCode) => console.log('Join room:', roomCode)} />
              </div>
            </motion.div>
          )}

          {currentView === 'create-room' && (
            <CreateRoomModal
              selectedGame={selectedGame}
              onClose={() => setCurrentView('menu')}
              onCreate={(data) => {
                const socket = getSocket();
                if (socket) {
                  (socket as any).emit('create_room', data);
                }
              }}
            />
          )}

          {currentView === 'join-room' && (
            <JoinRoomModal
              onClose={() => setCurrentView('menu')}
              onJoin={(roomCode) => {
                const socket = getSocket();
                if (socket) {
                  (socket as any).emit('join_room', { roomCode });
                }
              }}
            />
          )}

          {currentView === 'lobby' && currentRoom && (
            <RoomLobby
              room={currentRoom}
              currentUserId={auth.user.id}
              onLeave={() => {
                const socket = getSocket();
                if (socket) {
                  (socket as any).emit('leave_room', { roomId: currentRoom.id });
                }
                setCurrentRoom(null);
                setCurrentView('menu');
              }}
              onReady={(isReady) => {
                const socket = getSocket();
                if (socket) {
                  (socket as any).emit('player_ready', { roomId: currentRoom.id, isReady });
                }
              }}
              onStartGame={() => {
                const socket = getSocket();
                if (socket) {
                  (socket as any).emit('start_game', { roomId: currentRoom.id });
                }
              }}
            />
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

export default App;
