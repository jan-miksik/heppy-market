import { Link } from 'react-router-dom'

import { shortenAddress } from '../lib/format.js'

export default function AppShell({
  walletAddress,
  chainOk,
  busyWallet,
  onWalletClick,
  user,
  onLogout,
  children,
}) {
  return (
    <div className="app-root">
      <header className="topbar">
        <div className="topbar-left">
          <Link to="/connect" className="brand-link">Heppy Market · Initia</Link>
          <span className={`chain-dot ${chainOk ? 'ok' : 'off'}`} />
          <span className="muted-small">{chainOk ? 'chain online' : 'chain offline'}</span>
        </div>

        <div className="topbar-right">
          {user ? <span className="muted-small">session active</span> : <span className="muted-small">session missing</span>}
          {user && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
              Logout
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" disabled={busyWallet} onClick={onWalletClick}>
            {busyWallet ? 'Opening...' : walletAddress ? shortenAddress(walletAddress) : 'Connect Wallet'}
          </button>
        </div>
      </header>

      <main className="page">{children}</main>
    </div>
  )
}
