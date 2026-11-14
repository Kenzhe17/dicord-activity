import { cardInfo } from '@rize/uno/cards';
import type { UnoColor } from '@rize/uno/cards';

export const UNO_COLORS: Record<UnoColor, { main: string; deep: string; soft: string }> = {
  red: { main: '#d8402f', deep: '#8f1f14', soft: '#ffd9d2' },
  blue: { main: '#2f6fd0', deep: '#173f86', soft: '#d3e2ff' },
  green: { main: '#1f9e57', deep: '#0c5c31', soft: '#d2f2e2' },
  yellow: { main: '#e8a91c', deep: '#8f6106', soft: '#fdeec4' },
};

const RANK_LABEL: Record<string, string> = { skip: '⊘', reverse: '⇄', draw2: '+2', wild: 'W', draw4: '+4' };

export function unoCardLabel(id: number): string {
  const info = cardInfo(id);
  if (info.color === null) return info.rank === 'draw4' ? 'Дикая +4' : 'Дикая';
  const rank = typeof info.rank === 'number' ? String(info.rank) : RANK_LABEL[info.rank]!;
  return rank + ' ' + info.color;
}

/** UNO card face. `size` scales via CSS custom property --uno-w. */
export function UnoCard({ id, small = false, back = false, dim = false }: { id?: number; small?: boolean; back?: boolean; dim?: boolean }) {
  if (back || id === undefined) {
    return <div className={'uno-card back' + (small ? ' small' : '') + (dim ? ' dim' : '')} role="img" aria-label="Закрытая карта UNO"/>;
  }
  const info = cardInfo(id);
  const color = info.color ? UNO_COLORS[info.color] : null;
  const wild = info.rank === 'wild' || info.rank === 'draw4';
  const rankLabel = typeof info.rank === 'number' ? String(info.rank) : RANK_LABEL[info.rank]!;
  const cls = 'uno-card' + (small ? ' small' : '') + (dim ? ' dim' : '') + (wild ? ' wild' : '');
  return <div className={cls} role="img" aria-label={unoCardLabel(id)} style={color && !wild ? { borderColor: color.main } : undefined}>
    <span className="uno-corner tl" style={color ? { color: color.main } : undefined}>{rankLabel}</span>
    <span className="uno-center" style={color ? { color: color.main } : undefined}>
      {wild
        ? <span className={'uno-wild' + (info.rank === 'draw4' ? ' draw4' : '')}><i/><i/><i/><i/></span>
        : <span className="uno-glyph">{rankLabel}</span>}
    </span>
    <span className="uno-corner br" style={color ? { color: color.main } : undefined}>{rankLabel}</span>
  </div>;
}

/** Compact color chip used for the active color indicator. */
export function UnoColorChip({ color }: { color: UnoColor }) {
  return <span className={'uno-chip ' + color} aria-label={'Активный цвет: ' + color}/>;
}
