import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { api } from '../api';

interface Balance { enabled: boolean; available?: boolean; reason?: string; balance?: number; walletExists?: boolean; writesEnabled?: boolean }

export function balanceStatusText(balance: Balance, stake = 0): string {
  if (balance.available === false) {
    if (balance.reason === 'unauthorized') return 'Ошибка авторизации моста экономики';
    if (balance.reason === 'rate_limited') return 'Экономика временно перегружена';
    if (balance.reason === 'invalid_response') return 'Некорректный ответ economy-моста';
    return 'Баланс временно недоступен';
  }
  if (balance.writesEnabled === false) return 'Мост экономики в режиме «только чтение» — ставки отключены';
  if (balance.walletExists === false) return 'Кошелёк ещё не создан — стартовый баланс бота 100 монет';
  const coins = balance.balance ?? 0;
  let text = 'Баланс: ' + coins.toLocaleString('ru') + ' монет';
  if (stake > 0) text += coins >= stake ? ' — хватит на ставку' : ' — не хватает на ставку ' + stake.toLocaleString('ru');
  return text;
}

/** Compact shared-wallet indicator. Renders nothing when the economy bridge
 * is not configured; distinguishes real zero, missing wallet, read-only mode
 * and classified outages — never a fake balance. */
export function BalanceNote({ stake = 0, className }: { stake?: number; className?: string }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  useEffect(() => {
    let live = true;
    void api<Balance>('/economy/balance').then(b => { if (live) setBalance(b); }).catch(() => { if (live) setBalance({ enabled: false }); });
    return () => { live = false; };
  }, []);
  if (!balance?.enabled) return null;
  return <p className={'balance-note' + (className ? ' ' + className : '')}><Coins size={13}/>{balanceStatusText(balance, stake)}</p>;
}
