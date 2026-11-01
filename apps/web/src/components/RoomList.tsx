import { useEffect, useState } from 'react';
import { Room } from '@rize3-arcade/shared/dist/index.js';
import { motion } from 'framer-motion';
import { Users, Lock, Gamepad2 } from 'lucide-react';

interface RoomListProps {
  onJoin: (roomCode: string) => void;
}

export function RoomList({ onJoin }: RoomListProps) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRooms() {
      try {
        const serverUrl = __SERVER_URL__;
        const response = await fetch(`${serverUrl}/api/rooms/public`);
        const data = await response.json();
        setRooms(data.rooms || []);
      } catch (error) {
        console.error('Failed to fetch rooms:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchRooms();
    const interval = setInterval(fetchRooms, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <p className="text-secondary-text">Загрузка комнат...</p>;
  }

  if (rooms.length === 0) {
    return <p className="text-secondary-text">Нет доступных комнат</p>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {rooms.map((room) => (
        <motion.div
          key={room.id}
          whileHover={{ scale: 1.02 }}
          className="glass-panel p-4 cursor-pointer hover:border-gold/50"
          onClick={() => onJoin(room.code)}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Gamepad2 className="w-5 h-5 text-gold" />
              <span className="font-semibold capitalize">{room.gameType}</span>
            </div>
            {!room.isPublic && <Lock className="w-4 h-4 text-secondary-text" />}
          </div>
          <div className="flex items-center gap-2 text-secondary-text text-sm">
            <Users className="w-4 h-4" />
            <span>{room.players.length}/{room.maxPlayers}</span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
