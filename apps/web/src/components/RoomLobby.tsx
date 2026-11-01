import { motion } from 'framer-motion';
import { Room } from '@rize3-arcade/shared';
import { X, Check, Users, Gamepad2, Copy, LogOut } from 'lucide-react';

interface RoomLobbyProps {
  room: Room;
  currentUserId: string;
  onLeave: () => void;
  onReady: (isReady: boolean) => void;
  onStartGame: () => void;
}

export function RoomLobby({ room, currentUserId, onLeave, onReady, onStartGame }: RoomLobbyProps) {
  const currentPlayer = room.players.find(p => p.id === currentUserId);
  const isOwner = currentPlayer?.isOwner;
  const allReady = room.players.every(p => p.isReady);
  const canStart = isOwner && allReady && room.players.length >= 2;

  const copyRoomCode = () => {
    navigator.clipboard.writeText(room.code);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Room Header */}
      <div className="glass-panel p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Gamepad2 className="w-8 h-8 text-gold" />
            <div>
              <h2 className="text-2xl font-bold capitalize">{room.gameType}</h2>
              <p className="text-secondary-text">Комната</p>
            </div>
          </div>
          <button onClick={onLeave} className="btn-secondary">
            <LogOut className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex-1 glass-panel p-4 flex items-center justify-between">
            <span className="text-3xl font-bold tracking-widest">{room.code}</span>
            <button onClick={copyRoomCode} className="text-gold hover:text-white transition-colors">
              <Copy className="w-5 h-5" />
            </button>
          </div>
          <div className="flex items-center gap-2 text-secondary-text">
            <Users className="w-5 h-5" />
            <span>{room.players.length}/{room.maxPlayers}</span>
          </div>
        </div>
      </div>

      {/* Players List */}
      <div className="glass-panel p-6">
        <h3 className="text-xl font-bold mb-4">Игроки</h3>
        <div className="space-y-3">
          {room.players.map((player) => (
            <motion.div
              key={player.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-center justify-between p-4 bg-surface-secondary/50 rounded-lg"
            >
              <div className="flex items-center gap-4">
                <img
                  src={`https://cdn.discordapp.com/avatars/${player.id}/${player.discordUser.avatar || ''}.png`}
                  alt={player.discordUser.username}
                  className="w-12 h-12 rounded-full border-2 border-white/10"
                  onError={(e) => {
                    e.currentTarget.src = `https://cdn.discordapp.com/embed/avatars/${(parseInt(player.id) >> 22) % 6}.png`;
                  }}
                />
                <div>
                  <p className="font-semibold">{player.discordUser.global_name || player.discordUser.username}</p>
                  {player.isOwner && (
                    <p className="text-gold text-sm">Владелец</p>
                  )}
                </div>
              </div>

              {player.id === currentUserId ? (
                <button
                  onClick={() => onReady(!player.isReady)}
                  className={`px-4 py-2 rounded-lg font-semibold transition-all ${
                    player.isReady
                      ? 'bg-success text-white'
                      : 'bg-surface-secondary text-secondary-text hover:bg-white/10'
                  }`}
                >
                  {player.isReady ? (
                    <span className="flex items-center gap-2">
                      <Check className="w-4 h-4" />
                      Готов
                    </span>
                  ) : (
                    'Не готов'
                  )}
                </button>
              ) : (
                <div
                  className={`px-4 py-2 rounded-lg font-semibold ${
                    player.isReady ? 'bg-success/20 text-success' : 'bg-surface-secondary text-secondary-text'
                  }`}
                >
                  {player.isReady ? (
                    <span className="flex items-center gap-2">
                      <Check className="w-4 h-4" />
                      Готов
                    </span>
                  ) : (
                    'Не готов'
                  )}
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>

      {/* Start Game Button */}
      {isOwner && (
        <button
          onClick={onStartGame}
          disabled={!canStart}
          className={`btn-gold w-full ${!canStart ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {!allReady ? 'Ожидание готовности всех игроков' : room.players.length < 2 ? 'Нужно минимум 2 игрока' : 'Начать игру'}
        </button>
      )}
    </motion.div>
  );
}
