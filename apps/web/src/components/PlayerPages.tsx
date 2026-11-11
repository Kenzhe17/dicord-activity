import { useEffect, useState } from 'react';
import type { GameInfo, Profile, HistoryEntry, RankingEntry } from '@rize/shared';
import { Panel, Button } from '@rize/ui';
import { api, avatarSource } from '../api';
import { useArcade } from '../store';
export function PlayerPages({ page, games, onError }: { page: string; games: GameInfo[]; onError: (error: string) => void }) {
  const { session, preferences, setPreferences } = useArcade();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [gameId, setGameId] = useState('durak');
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<{ enabled: boolean; available?: boolean; balance?: number; walletExists?: boolean } | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const load = async () => {
      if (page === 'profile') { const [value, coins] = await Promise.all([api<Profile>('/profile'), api<typeof balance>('/economy/balance').catch(() => null)]); if (!cancelled) { setProfile(value); setBalance(coins); } }
      if (page === 'history') { const value = await api<HistoryEntry[]>('/history'); if (!cancelled) setHistory(value); }
      if (page === 'rankings') { const value = await api<RankingEntry[]>('/rankings/' + gameId); if (!cancelled) setRankings(value); }
    };
    void load().catch(reason => { if (!cancelled) onError(reason instanceof Error ? reason.message : 'Не удалось загрузить данные'); });
    return () => { cancelled = true; };
  }, [session, page, gameId, onError]);
  if (!session) return <Panel><h2>Ваше место в клубе</h2><p>Войдите, чтобы увидеть профиль, историю и настройки.</p></Panel>;
  if (page === 'settings') return <section className="page-section"><p className="eyebrow">ВАШ ARCADE</p><h1>Настройки</h1><Panel><h2>Удобно именно вам</h2><p className="muted">Настройки сохраняются в профиле и восстанавливаются при следующем входе.</p><form onSubmit={event => { event.preventDefault(); setBusy(true); void api('/preferences', { method: 'PUT', body: JSON.stringify(preferences) }).catch(reason => onError(String(reason))).finally(() => setBusy(false)); }}><label className="setting-row"><span>Уменьшить анимацию</span><input type="checkbox" checked={preferences.reducedMotion} onChange={e => setPreferences({ ...preferences, reducedMotion: e.target.checked })}/></label><label className="setting-row"><span>Компактные карточки игр</span><input type="checkbox" checked={preferences.compactCards} onChange={e => setPreferences({ ...preferences, compactCards: e.target.checked })}/></label><Button disabled={busy} type="submit">{busy ? 'Сохраняем…' : 'Сохранить настройки'}</Button></form></Panel></section>;
  if (page === 'profile') return <section className="page-section"><p className="eyebrow">ЛИЧНОЕ ДЕЛО</p><h1>Профиль игрока</h1><Panel><div className="profile-heading">{session.player.avatar ? <img className="profile-avatar" src={avatarSource(session.player.avatar)} alt=""/> : <span className="profile-avatar avatar">{session.player.name.slice(0, 1)}</span>}<div><h2>{session.player.name}</h2><p className="muted">@{session.player.username ?? session.player.name}</p></div></div><div className="stat-grid">{[['Матчи', profile?.statistics.reduce((n, s) => n + s.played, 0) ?? 0], ['Победы', profile?.statistics.reduce((n, s) => n + s.wins, 0) ?? 0], ['В клубе с', profile ? new Date(profile.joinedAt).toLocaleDateString('ru') : '…'], ...(balance?.enabled ? [['Монеты r!z3', balance.available === false ? 'недоступно' : balance.walletExists === false ? '—' : String(balance.balance ?? 0)]] : [])].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>{balance?.enabled && balance.available !== false && !balance.walletExists && <p className="muted">Кошелёк ещё не создан — он появится после первой операции с монетами в основном боте.</p>}</Panel>{profile?.statistics.map(stat => <Panel key={stat.gameId}><h2>{games.find(g => g.id === stat.gameId)?.name ?? stat.gameId}</h2><p>{stat.wins} побед · {stat.losses} поражений · {stat.draws} ничьих</p></Panel>)}</section>;
  if (page === 'history') return <section className="page-section"><p className="eyebrow">ВАШИ ПАРТИИ</p><h1>История матчей</h1>{history.length === 0 ? <Panel><h2>История начинается за столом</h2><p className="muted">Завершённые партии появятся здесь. В режиме разработки можно проверить испытательный стол.</p></Panel> : history.map(item => <Panel key={item.id}><div className="room-list-row"><div><h2>{games.find(g => g.id === item.gameId)?.name ?? item.gameId}</h2><p className="muted">{item.finishedAt ? new Date(item.finishedAt).toLocaleString('ru') : ''}</p></div><div><strong>{item.outcome === 'win' ? 'Победа' : item.outcome === 'draw' ? 'Ничья' : 'Поражение'}</strong><p className="muted">Результат сохранён</p></div></div></Panel>)}</section>;
  return <section className="page-section"><p className="eyebrow">ЛУЧШИЕ ЗА СТОЛОМ</p><h1>Рейтинги</h1><p className="muted">Рейтинговые очки временно не начисляются. Здесь показана статистика завершённых партий.</p><label className="filter-label">Игра<select aria-label="Игра" value={gameId} onChange={e => setGameId(e.target.value)}>{games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>{rankings.length === 0 ? <Panel><h2>Пока нет завершённых партий</h2><p className="muted">Статистика появится после первой завершённой партии.</p></Panel> : <Panel>{rankings.map(entry => <div className="ranking-row" key={entry.player.id}><span className="rank-place">{String(entry.place).padStart(2, '0')}</span><strong>{entry.player.name}</strong><span>{entry.wins} побед</span><b>{entry.played} игр</b></div>)}</Panel>}</section>;
}
