import { motion } from 'framer-motion';
import { Room, DurakGameState } from '@rize3-arcade/shared/dist/index.js';
import { Check, Users, Gamepad2, Copy, LogOut } from 'lucide-react';

interface RoomLobbyProps {
  room: Room;
  currentUserId: string;
  onLeave: () => void;
  onReady: (isReady: boolean) => void;
  onStartGame: () => void;
  gameState?: DurakGameState;
}

export function RoomLobby({ room, currentUserId, onLeave, onReady, onStartGame, gameState }: RoomLobbyProps) {
  const currentPlayer = room.players.find(p => p.id === currentUserId);
  const isOwner = currentPlayer?.isOwner;
  const allReady = room.players.every(p => p.isReady);
  const canStart = isOwner && allReady && room.players.length >= 2;
  const isPlaying = room.status === 'playing';

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

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-secondary-text">
              <Users className="w-5 h-5" />
              <span>{room.players.length}/{room.maxPlayers}</span>
            </div>
            <div className="flex items-center justify-between text-sm gap-6">
              <div className="text-secondary-text">Ставка: <span className="text-gold font-bold">{room.bet}</span></div>
              <div className="text-secondary-text">Банк: <span className="text-gold font-bold">{room.bank}</span></div>
            </div>
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
                  <p className="font-semibold">{player.discordUser.username}</p>
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
      {isOwner && !isPlaying && (
        <button
          onClick={() => {
            if (canStart) {
              onStartGame();
            } else {
              alert('Игра Дурак ещё не реализована. Ожидайте выхода игры.');
            }
          }}
          disabled={!canStart}
          className={`btn-gold w-full ${!canStart ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {!allReady ? 'Ожидание готовности всех игроков' : room.players.length < 2 ? 'Нужно минимум 2 игрока' : 'Начать игру'}
        </button>
      )}

      {/* Game UI (when playing) */}
      {isPlaying && gameState && (
        <div className="glass-panel p-6">
          <h3 className="text-xl font-bold mb-4">Игра Дурак</h3>
          
          {/* Trump Card */}
          {gameState.trumpCard && (
            <div className="mb-4 p-4 bg-gold/10 rounded-lg">
              <p className="text-sm text-secondary-text mb-2">Козырь:</p>
              <div className="text-2xl font-bold">
                {gameState.trumpCard.rank} {gameState.trumpCard.suit === 'hearts' ? '♥' : gameState.trumpCard.suit === 'diamonds' ? '♦' : gameState.trumpCard.suit === 'clubs' ? '♣' : '♠'}
              </div>
            </div>
          )}

          {/* Table Cards */}
          <div className="mb-4">
            <p className="text-sm text-secondary-text mb-2">Стол:</p>
            <div className="flex gap-2 flex-wrap">
              {gameState.table.map((card) => (
                <div key={card.id} className="p-3 bg-surface-secondary rounded border border-gold/30 text-center">
                  <div className="text-lg font-bold">{card.rank}</div>
                  <div className="text-xs">{card.suit === 'hearts' ? '♥' : card.suit === 'diamonds' ? '♦' : card.suit === 'clubs' ? '♣' : '♠'}</div>
                </div>
              ))}
              {gameState.table.length === 0 && <p className="text-secondary-text">Пусто</p>}
            </div>
          </div>

          {/* Game Info */}
          <div className="text-sm text-secondary-text">
            <p>Очередь: {room.players.find(p => p.id === gameState.currentTurn)?.discordUser.username || 'Неизвестно'}</p>
            <p>Карт в колоде: {gameState.deck.length}</p>
          </div>
        </div>
      )}
    </motion.div>
  );
}
