import { useEffect, useState } from 'react';
import { Room } from '@rize3-arcade/shared/dist/index.js';
import { motion } from 'framer-motion';
import { Users, Gamepad2 } from 'lucide-react';

interface RoomListProps {
  onJoin: (roomCode: string, password: string) => void;
}

export function RoomList({ onJoin }: RoomListProps) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [passwordInputs, setPasswordInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    async function fetchRooms() {
      try {
        const serverUrl = __SERVER_URL__ || '';
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
          className="glass-panel p-4"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Gamepad2 className="w-5 h-5 text-gold" />
              <span className="font-semibold capitalize">
                {room.gameType === 'durak' ? 'Дурак' : room.gameType}
              </span>
            </div>
          </div>
          <div className="space-y-2 text-sm mb-3">
            <div className="text-secondary-text">
              Владелец: {room.owner?.discordUser?.username || room.players[0]?.discordUser?.username || 'Неизвестно'}
            </div>
            <div className="text-secondary-text">
              Ставка: {room.bet}
            </div>
            <div className="text-secondary-text">
              Банк: {room.bank}
            </div>
            <div className="flex items-center gap-2 text-secondary-text">
              <Users className="w-4 h-4" />
              <span>{Array.isArray(room.players) ? room.players.length : 0}/{room.maxPlayers || 6}</span>
            </div>
          </div>
          <div className="space-y-2">
            <input
              type="text"
              placeholder="Пароль"
              value={passwordInputs[room.id] || ''}
              onChange={(e) => setPasswordInputs({ ...passwordInputs, [room.id]: e.target.value })}
              className="w-full p-2 rounded border border-gold bg-gold/10 text-sm"
            />
            <button
              onClick={() => onJoin(room.code, passwordInputs[room.id] || '')}
              className="btn-gold w-full"
              disabled={!passwordInputs[room.id]}
            >
              Войти
            </button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
