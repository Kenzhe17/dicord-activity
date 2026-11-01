import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface JoinRoomModalProps {
  onClose: () => void;
  onJoin: (roomCode: string) => void;
}

export function JoinRoomModal({ onClose, onJoin }: JoinRoomModalProps) {
  const [roomCode, setRoomCode] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomCode.trim()) {
      onJoin(roomCode.trim().toUpperCase());
    }
  };

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
            <h2 className="text-2xl font-bold">Присоединиться к комнате</h2>
            <button onClick={onClose} className="text-secondary-text hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-semibold mb-2">Код комнаты</label>
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
                className="w-full px-4 py-3 bg-surface-secondary border border-white/10 rounded-lg focus:border-gold focus:outline-none text-center text-2xl tracking-widest uppercase"
              />
            </div>

            <button type="submit" className="btn-gold w-full" disabled={!roomCode.trim()}>
              Присоединиться
            </button>
          </form>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
