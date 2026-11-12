import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { api } from '../api';

interface Balance { enabled: boolean; available?: boolean; balance?: number; walletExists?: boolean }

/** Compact shared-wallet indicator. Renders nothing when the economy bridge
 * is not configured; distinguishes real zero, missing wallet and outages. */
export function BalanceNote({ stake = 0, className }: { stake?: number; className?: string }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  useEffect(() => {
    let live = true;
    void api<Balance>('/economy/balance').then(b => { if (live) setBalance(b); }).catch(() => { if (live) setBalance({ enabled: false }); });
    return () => { live = false; };
  }, []);
  if (!balance?.enabled) return null;
  let text: string;
  if (balance.available === false) text = 'Баланс временно недоступен';
  else if (balance.walletExists === false) text = 'Кошелёк ещё не создан — стартовый баланс бота 100 монет';
  else {
    const coins = balance.balance ?? 0;
    text = 'Баланс: ' + coins.toLocaleString('ru') + ' монет';
    if (stake > 0) text += coins >= stake ? ' — хватит на ставку' : ' — не хватает на ставку ' + stake.toLocaleString('ru');
  }
  return <p className={'balance-note' + (className ? ' ' + className : '')}><Coins size={13}/>{text}</p>;
}
