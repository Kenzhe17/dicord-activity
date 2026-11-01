import { motion } from 'framer-motion';
import { GameType } from '@rize3-arcade/shared/dist/index.js';
import { Users, Play } from 'lucide-react';

interface GameCardProps {
  game: GameType;
  title: string;
  description: string;
  players: string;
  onClick: () => void;
}

export function GameCard({ game, title, description, players, onClick }: GameCardProps) {
  const gameIcons: Record<GameType, string> = {
    durak: '🃏',
    uno: '🎴',
    mafia: '🕵️',
  };

  return (
    <motion.div
      whileHover={{ scale: 1.05, y: -5 }}
      whileTap={{ scale: 0.95 }}
      className="glass-panel p-6 cursor-pointer hover:border-gold/50 transition-all"
      onClick={onClick}
    >
      <div className="text-6xl mb-4">{gameIcons[game]}</div>
      <h3 className="text-xl font-bold mb-2">{title}</h3>
      <p className="text-secondary-text mb-4 text-sm">{description}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-secondary-text">
          <Users className="w-4 h-4" />
          <span className="text-sm">{players}</span>
        </div>
        <Play className="w-5 h-5 text-gold" />
      </div>
    </motion.div>
  );
}
