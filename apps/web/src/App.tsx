import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, MotionConfig } from 'motion/react';
import { ArrowUpRight, Layers3, Users, Spade, Palette, VenetianMask, Radio, LogOut, House, UserRound, History, Trophy, Settings, ArrowLeft, FlaskConical } from 'lucide-react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { AuthSession } from '@rize/discord';
import type { ActivityContext, ActivityClient } from '@rize/discord/client';
import type { GameInfo, RoomView, RoomSummary, ClientToServerEvents, ServerToClientEvents, Preferences, MatchView } from '@rize/shared';
import { Button, Panel } from '@rize/ui';
import { api, post, proxyPrefix, avatarSource } from './api';
import { useArcade, storedToken } from './store';
import { PlayerPages } from './components/PlayerPages';
import { Lobby } from './components/Lobby';
import { connectRoom } from './realtime';

interface PublicConfig { authMode: 'disabled' | 'mock' | 'discord'; clientId: string | null; persistence: string; testGame: boolean }
interface Bootstrap { session: AuthSession; room: RoomView | null; match: MatchView | null; preferences: Preferences }
const icons = { durak: Spade, uno: Palette, mafia: VenetianMask, sandbox: FlaskConical };
const navigation = [['home', 'Главная', House], ['games', 'Библиотека', Layers3], ['rooms', 'Комнаты', Users], ['profile', 'Профиль', UserRound], ['history', 'История', History], ['rankings', 'Рейтинги', Trophy], ['settings', 'Настройки', Settings]] as const;
const currentRoute = () => location.hash.replace(/^#\/?/, '') || 'home';
export function App() {
  const { session, room, preferences, setSession, setRoom, setMatch, setPreferences } = useArcade();
  const [games, setGames] = useState<GameInfo[]>([]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [route, setRoute] = useState(currentRoute);
  const [name, setName] = useState('Игрок');
  const [roomName, setRoomName] = useState('Вечерняя партия');
  const [privateRoom, setPrivateRoom] = useState(false);
  const [mode, setMode] = useState('throw-in');
  const [capacity, setCapacity] = useState(6);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('Не подключено');
  const [context, setContext] = useState<ActivityContext | null>(null);
  const activity = useRef<ActivityClient | null>(null);
  const started = useRef(false);
  const page = route.split('/')[0] ?? 'home';
  const selected = games.find(g => g.id === route.split('/')[1]);
  const navigate = useCallback((value: string) => { location.hash = '/' + value; setRoute(value); }, []);
  useEffect(() => { const changed = () => setRoute(currentRoute()); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось выполнить действие'); } finally { setBusy(false); }
  }, []);
  async function restore() {
    const value = await api<Bootstrap>('/bootstrap');
    setSession(value.session); setRoom(value.room); setMatch(value.match); setPreferences(value.preferences);
    if (value.room && ['home', 'room'].includes(currentRoute())) navigate('room');
  }
  async function discordLogin(settings: PublicConfig) {
    if (!settings.clientId) throw new Error('Discord-приложение не настроено');
    if (!new URLSearchParams(location.search).has('frame_id')) throw new Error('Откройте Arcade как Activity внутри Discord');
    const { getActivityClient } = await import('@rize/discord/client');
    activity.current = getActivityClient(settings.clientId);
    const { state } = await post<{ state: string }>('/auth/challenge');
    const value = await activity.current.login(state,
      (code, nonce) => post('/auth/discord', { code, state: nonce }),
      token => api('/session', { method: 'DELETE', headers: { authorization: 'Bearer ' + token } }),
      setContext,
    );
    setSession(value); await restore();
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(async () => {
      const [list, settings] = await Promise.all([api<GameInfo[]>('/games'), api<PublicConfig>('/config')]);
      setGames(list); setConfig(settings);
      if (settings.authMode === 'discord' && new URLSearchParams(location.search).has('frame_id')) await discordLogin(settings);
      else if (storedToken()) await restore();
    });
  }, []);
  useEffect(() => {
    if (!session || !room) return;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ autoConnect: false, auth: { token: session.token }, path: proxyPrefix() + '/socket.io', transports: ['websocket'] });
    return connectRoom(socket, room.id, {
      connection: setConnection, room: setRoom, match: setMatch, error: setError,
      closed: () => { setRoom(null); setMatch(null); navigate('rooms'); },
    });
  }, [session?.token, room?.id, setRoom, setMatch, navigate]);
  useEffect(() => {
    if (session && page === 'rooms') void api<RoomSummary[]>('/rooms').then(setRooms).catch(reason => setError(String(reason)));
  }, [session?.token, page]);
  const login = () => run(async () => {
    if (config?.authMode === 'mock') { setSession(await post<AuthSession>('/auth/dev', { name })); await restore(); }
    else if (config?.authMode === 'discord') await discordLogin(config);
    else throw new Error('Авторизация отключена в конфигурации сервера');
  });
  const logout = () => run(async () => { await api('/session', { method: 'DELETE' }); await activity.current?.dispose(); setSession(null); setContext(null); navigate('home'); });
  const join = (code: string) => run(async () => {
    const [id, inviteToken] = code.trim().split(':');
    setRoom(await post<RoomView>('/rooms/' + encodeURIComponent(id ?? '') + '/join', inviteToken ? { inviteToken } : {}));
    setMatch(null); navigate('room');
  });
  const library = <section className="library"><div className="section-heading"><div><p className="eyebrow">ВЫБИРАЙТЕ КОМПАНИЮ</p><h2>Библиотека игр</h2></div><span className="muted">Три классики. Один клуб.</span></div><div className="game-grid">{games.map((game, index) => {
    const Icon = icons[game.id as keyof typeof icons] ?? Layers3;
    return <motion.button key={game.id} className={'game-card game-' + game.id} initial={preferences.reducedMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} onClick={() => navigate('game/' + game.id)}><div className="game-art"><span className="game-number">0{index + 1}</span><Icon size={80} strokeWidth={1}/><span className="game-tag">{game.status === 'planned' ? 'СКОРО' : game.id === 'sandbox' ? 'DEV · ТЕСТ' : 'ИГРАТЬ'}</span></div><div className="game-copy"><h3>{game.name}<ArrowUpRight size={20}/></h3><p>{game.description}</p><span><Users size={14}/>{game.minPlayers}–{game.maxPlayers} игроков</span></div></motion.button>;
  })}</div></section>;
  return <MotionConfig reducedMotion={preferences.reducedMotion ? 'always' : 'user'}><div className={'shell' + (preferences.compactCards ? ' compact-cards' : '')}>
    <aside className="sidebar">
      <a className="brand" href="#/home"><span className="brand-mark">r!</span><span>r!z3 <b>ARCADE</b></span></a>
      <span className="nav-label">ВАШ ИГРОВОЙ КЛУБ</span>
      <nav aria-label="Основная навигация">{navigation.map(([id, label, Icon]) => <button key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(id)}><Icon size={19}/>{label}</button>)}</nav>
      <div className="sidebar-note"><span className="status-dot"/> R!Z3 SOCIAL CLUB<p>Общий стол начинается<br/>с хорошей компании.</p></div>
      <div className="identity"><span className="avatar">{session?.player.avatar ? <img src={avatarSource(session.player.avatar)} alt=""/> : session?.player.name.slice(0, 1) ?? 'Г'}</span><div><strong>{session?.player.name ?? 'Гость'}</strong><small>{config?.authMode === 'mock' ? 'Локальная сессия' : 'Discord Activity'}</small></div>{session && <button aria-label="Выйти" className="icon-button" disabled={busy} onClick={() => void logout()}><LogOut size={18}/></button>}</div>
    </aside>
    <main>
      <header className="topbar"><span>МЕСТО ВСТРЕЧИ — ARCADE</span><div className="topbar-actions">{session && <button className="icon-button mobile-session" aria-label="Выйти из сессии" disabled={busy} onClick={() => void logout()}><LogOut size={16}/></button>}{room && page !== 'room' && <button className="text-button" onClick={() => navigate('room')}>Вернуться за стол</button>}<span className="connection"><Radio size={14}/>{room ? connection : context ? 'Discord · ' + context.platform : 'Ваш игровой клуб'}</span></div></header>
      {error && <div role="alert" className="error">{error}<button aria-label="Закрыть сообщение" onClick={() => setError('')}>×</button></div>}
      {context && <div className="activity-strip"><Users size={14}/><span>{context.participantsAvailable ? 'В Activity: ' + context.participants.map(p => p.name).join(', ') : 'Activity подключена · список участников недоступен в этом клиенте'}</span></div>}
      {!session && <Panel className="login-panel"><div><h2>Займите своё место</h2><p className="muted">{config?.authMode === 'mock' ? 'Локальный режим разработки — без доступа к Discord и экономике.' : 'Войдите через Discord, чтобы присоединиться к компании.'}</p></div><form onSubmit={event => { event.preventDefault(); void login(); }}>{config?.authMode === 'mock' && <input aria-label="Имя игрока" value={name} maxLength={40} onChange={event => setName(event.target.value)}/>}<Button type="submit" disabled={busy || !config || config.authMode === 'disabled'}>{busy ? 'Подключаем…' : config?.authMode === 'mock' ? 'Войти локально' : 'Войти через Discord'}</Button></form></Panel>}
      {page === 'room' && room ? <Lobby games={games} run={run} busy={busy} onLeft={() => navigate('rooms')}/> : page === 'home' || page === 'games' ? <>
        {page === 'home' && <section className="hero"><p className="eyebrow">R!Z3 ARCADE / СВОИ ЛЮДИ, ХОРОШИЕ ИГРЫ</p><h1>Встречаемся<br/><span>за игровым столом.</span></h1><p className="subtitle">Любимые игры. Знакомые голоса.<br/>Один клуб внутри Discord.</p><div className="button-row"><Button onClick={() => navigate('games')}>Выбрать игру <ArrowUpRight size={15}/></Button><button className="text-button" onClick={() => navigate('rooms')}>Найти компанию</button></div><div className="hero-art" aria-hidden="true"><div className="art-card card-back"/><div className="art-card card-front"><Spade size={64}/><span>r!z3</span></div><span className="art-orbit"/></div></section>}
        {library}
        {page === 'home' && <div className="club-note"><span>01 / ВЫБЕРИТЕ ИГРУ</span><span>02 / СОБЕРИТЕ СВОИХ</span><span>03 / ЗАЙМИТЕ МЕСТА</span></div>}
      </> : page === 'rooms' ? <section className="page-section"><p className="eyebrow">НАЙДИТЕ СВОЮ КОМПАНИЮ</p><div className="section-heading"><h1>Комнаты</h1><Button disabled={busy || !session} onClick={() => void run(async () => setRooms(await api('/rooms')))}>Обновить</Button></div>{!session ? <Panel>Войдите, чтобы увидеть комнаты.</Panel> : <><Panel><form className="join-form" onSubmit={event => { event.preventDefault(); void join(invite); }}><label htmlFor="invite">Войти по коду</label><input id="invite" value={invite} onChange={event => setInvite(event.target.value)} placeholder="Приглашение от хоста" required/><Button disabled={busy} type="submit">Присоединиться</Button></form></Panel>{rooms.length === 0 ? <Panel><h2>Первый стол — ваш</h2><p className="muted">Пока нет открытых комнат. Выберите игру и создайте свою.</p><Button onClick={() => navigate('games')}>Выбрать игру</Button></Panel> : rooms.map(item => <Panel key={item.id}><div className="room-list-row"><div><h3>{item.name}</h3><span className="muted">{games.find(g => g.id === item.gameId)?.name} · {item.players}/{item.maxPlayers}</span></div><Button disabled={busy || item.players >= item.maxPlayers || !!room && room.id !== item.id} onClick={() => void join(item.id)}>Войти</Button></div></Panel>)}</>}</section>
      : (page === 'game' || page === 'create') && selected ? <section className="page-section"><button className="text-button" onClick={() => navigate('games')}><ArrowLeft size={16}/>Все игры</button><p className="eyebrow">{selected.status === 'planned' ? 'СКОРО В ARCADE' : selected.id === 'sandbox' ? 'ТОЛЬКО ДЛЯ РАЗРАБОТКИ' : 'КАРТОЧНЫЙ КЛУБ'}</p><h1>{page === 'create' ? 'Создать комнату' : selected.name}</h1><p className="subtitle">{selected.description}</p><Panel><h2>{selected.name}</h2><p>{selected.modes.join(' / ')} · {selected.minPlayers}–{selected.maxPlayers} игроков</p>{selected.status === 'planned' && <p className="foundation-note">Лобби уже доступны. Игровой движок появится после проверки правил и тестирования.</p>}
        {page === 'game' ? <Button disabled={!session || !!room} onClick={() => navigate('create/' + selected.id)}>Создать комнату</Button> : session && <form className="create-form" onSubmit={event => { event.preventDefault(); void run(async () => { setRoom(await post('/rooms', { requestId: crypto.randomUUID(), gameId: selected.id, name: roomName, visibility: privateRoom ? 'private' : 'public', settings: selected.id === 'durak' ? { mode, maxPlayers: capacity } : {} })); setMatch(null); navigate('room'); }); }}><label>Название комнаты<input value={roomName} onChange={event => setRoomName(event.target.value)} maxLength={64} required/></label>{selected.id === 'durak' && <label>Режим<select aria-label="Режим" value={mode} onChange={e => setMode(e.target.value)}><option value="throw-in">Подкидной</option><option value="transfer">Переводной</option></select></label>}{selected.id === 'durak' && <label>Мест за столом<select aria-label="Мест за столом" value={capacity} onChange={e => setCapacity(Number(e.target.value))}>{[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} игроков</option>)}</select></label>}<label className="checkbox"><input type="checkbox" checked={privateRoom} onChange={event => setPrivateRoom(event.target.checked)}/>Приватная комната</label><Button disabled={busy || !!room} type="submit">Создать лобби</Button></form>}</Panel></section>
      : ['profile', 'history', 'rankings', 'settings'].includes(page) ? <PlayerPages page={page} games={games} onError={setError}/> : <Panel><h2>Страница не найдена</h2><Button onClick={() => navigate('home')}>На главную</Button></Panel>}
      <footer><span>r!z3 Arcade</span><span>Собирает друзей. Сохраняет ваши партии.</span></footer>
    </main>
  </div></MotionConfig>;
}
