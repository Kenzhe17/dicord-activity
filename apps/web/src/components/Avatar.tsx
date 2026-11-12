import { useEffect, useState, type ReactNode } from 'react';
import { avatarSource } from '../api';

export function Avatar({ src, name, className, children }: { src?: string | null | undefined; name: string; className: string; children?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={className}>{src && !failed ? <img src={avatarSource(src)} alt="" onError={() => setFailed(true)}/> : name.slice(0, 1).toUpperCase()}{children}</span>;
}
