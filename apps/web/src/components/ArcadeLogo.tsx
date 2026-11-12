/** Official r!z3 server logo. The app is always served under the '/.proxy'
 * base (Vite base in dev, Discord proxy prefix in production); the server's
 * rewriteUrl strips that prefix before static files are served, so this URL
 * resolves identically inside Discord, in dev and in a plain browser. */
export function ArcadeLogo({ className }: { className?: string }) {
  return <img className={'arcade-logo' + (className ? ' ' + className : '')} src={'/.proxy/assets/logo.png'} alt="r!z3" draggable={false} />;
}
