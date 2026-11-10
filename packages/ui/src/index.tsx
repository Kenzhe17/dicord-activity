import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function Button({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={'button ' + className} {...props}>{children}</button>;
}
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={'panel ' + className}>{children}</section>;
}
