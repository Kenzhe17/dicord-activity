import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GameType } from '@rize3-arcade/shared';
import { X, Users, Settings } from 'lucide-react';

interface CreateRoomModalProps {
  selectedGame: GameType | null;
  onClose: () => void;
  onCreate: (data: { gameType: GameType; maxPlayers: number; isPublic: boolean }) => void;
}

export function CreateRoomModal({ selectedGame, onClose, onCreate }: CreateRoomModalProps) {
  const [gameType, setGameType] = useState<GameType>(selectedGame || 'durak');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [isPublic, setIsPublic] = useState(true);

  const gameConfig: Record<GameType, { min: number; max: number; default: number }> = {
    durak: { min: 2, max: 6, default: 4 },
    uno: { min: 2, max: 10, default: 4 },
    mafia: { min: 5, max: 12, default: 8 },
  };

  const config = gameConfig[gameType];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="glass-panel p-6 max-w-md w-full mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Создать комнату</h2>
            <button onClick={onClose} className="text-secondary-text hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>

          <div className="space-y-6">
            {/* Game Type Selection */}
            <div>
              <label className="block text-sm font-semibold mb-2">Игра</label>
              <div className="grid grid-cols-3 gap-2">
                {(['durak', 'uno', 'mafia'] as GameType[]).map((game) => (
                  <button
                    key={game}
                    onClick={() => setGameType(game)}
                    className={`p-3 rounded-lg border transition-all ${
                      gameType === game
                        ? 'border-gold bg-gold/10'
                        : 'border-white/10 hover:border-white/30'
                    }`}
                  >
                    <span className="capitalize">{game}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Max Players */}
            <div>
              <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
                <Users className="w-4 h-4" />
                Максимум игроков
              </label>
              <input
                type="range"
                min={config.min}
                max={config.max}
                value={maxPlayers}
                onChange={(e) => setMaxPlayers(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="text-center text-gold font-bold mt-2">{maxPlayers}</div>
            </div>

            {/* Public/Private */}
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Публичная комната
              </label>
              <button
                onClick={() => setIsPublic(!isPublic)}
                className={`w-12 h-6 rounded-full transition-all ${
                  isPublic ? 'bg-gold' : 'bg-surface-secondary'
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full transition-all ${
                    isPublic ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            {/* Create Button */}
            <button
              onClick={() => onCreate({ gameType, maxPlayers, isPublic })}
              className="btn-gold w-full"
            >
              Создать
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
