import { useId } from 'react';
const names = ['треф', 'бубен', 'червей', 'пик'];
const ranks = ['6', '7', '8', '9', '10', 'Валет', 'Дама', 'Король', 'Туз'];
const labels = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const paths = [
  'M10 1C5-1 3 5 7 8C0 5-2 13 3 15C6 17 8 14 9 12L7 19H13L11 12C13 17 20 17 20 11C20 7 16 6 13 8C17 4 14-1 10 1Z',
  'M10 0L19 10L10 20L1 10Z',
  'M10 19C7 15 0 11 0 6C0-1 8-1 10 4C12-1 20-1 20 6C20 11 13 15 10 19Z',
  'M10 0C7 4 0 8 0 13C0 18 7 19 9 14L7 20H13L11 14C13 19 20 18 20 13C20 8 13 4 10 0Z',
];
export const playingCardLabel = (card: number) => ranks[card % 9] + ' ' + names[Math.floor(card / 9)];
export function PlayingCard({ card, back = false }: { card?: number; back?: boolean }) {
  const id = useId().replaceAll(':', ''), s = Math.floor((card ?? 0) / 9), r = (card ?? 0) % 9;
  const color = s === 1 || s === 2 ? '#b3444e' : '#1b2e34';
  const pip = (x: number, y: number, scale = 0.6) => <path d={paths[s]} transform={'translate(' + x + ' ' + y + ') scale(' + scale + ')'} fill={color}/>;
  return <svg className="playing-card" viewBox="0 0 80 116" role="img" aria-label={back ? 'Закрытая карта' : playingCardLabel(card ?? 0)}>
    <defs><linearGradient id={'paper' + id} x2="1" y2="1"><stop stopColor="#fffdf6"/><stop offset="1" stopColor="#e8e2d5"/></linearGradient><pattern id={'back' + id} width="12" height="12" patternUnits="userSpaceOnUse"><path d="M6 0L12 6L6 12L0 6Z" fill="none" stroke="#8875b1" strokeWidth=".5"/></pattern></defs>
    <rect x=".8" y=".8" width="78.4" height="114.4" rx="7" fill={'url(#paper' + id + ')'} stroke="#d6cdbd" strokeWidth="1.3"/>
    {back ? <><rect x="5" y="5" width="70" height="106" rx="4" fill="#29223e"/><rect x="8" y="8" width="64" height="100" rx="3" fill={'url(#back' + id + ')'} stroke="#bba379" strokeWidth=".7"/><path d="M40 27L62 58L40 89L18 58Z" fill="#29223e" stroke="#bba379"/><text x="40" y="62" textAnchor="middle" fill="#d4c3ee" fontSize="12" fontWeight="700" fontFamily="Georgia,serif">r!z3</text></> : <>
      <g fill={color} fontFamily="Georgia,serif" fontWeight="700"><text x="6" y="18" fontSize={r === 4 ? 14 : 17}>{labels[r]}</text>{pip(6, 22, .45)}<g transform="rotate(180 40 58)"><text x="6" y="18" fontSize={r === 4 ? 14 : 17}>{labels[r]}</text>{pip(6, 22, .45)}</g></g>
      {r <= 4 ? <>{[29, 73].map(y => <g key={y}>{pip(22, y)}{pip(46, y)}</g>)}{r >= 0 && pip(22, 51)}{r >= 0 && pip(46, 51)}{r >= 1 && pip(34, 39, .5)}{r >= 2 && pip(34, 65, .5)}{r >= 3 && pip(34, 22, .5)}{r >= 4 && pip(34, 84, .5)}</> : r === 8 ? <>{pip(23, 40, 1.7)}<text x="40" y="90" textAnchor="middle" fill="#9f8c64" fontSize="6" letterSpacing="2">R!Z3 CLUB</text></> : <><path d="M40 28L59 46V77L40 89L21 77V46Z" fill="none" stroke="#b6a37c"/><path d="M28 48L25 37L34 43L40 32L46 43L55 37L52 48Z" fill="#b6a37c"/><text x="40" y="73" textAnchor="middle" fontFamily="Georgia,serif" fontSize="27" fill={color}>{labels[r]}</text>{pip(35, 78, .5)}</>}
    </>}
  </svg>;
}
