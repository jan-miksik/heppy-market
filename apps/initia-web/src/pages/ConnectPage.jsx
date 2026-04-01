export default function ConnectPage({
  initia,
  user,
  authBusy,
  authError,
  onAuthenticate,
}) {
  const walletConnected = Boolean(initia.initiaAddress)

  return (
    <section className="panel stack-md">
      <div className="stack-sm">
        <h1 className="title">Connect Wallet</h1>
        <p className="muted">Connect your Initia wallet, then sign in with the same wallet to continue.</p>
      </div>

      <div className="row-wrap">
        {!walletConnected ? (
          <button type="button" className="btn btn-primary" onClick={initia.openConnect} disabled={Boolean(initia.busyAction) || authBusy}>
            {initia.busyAction ? 'Opening...' : 'Connect Wallet'}
          </button>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={initia.openWallet} disabled={Boolean(initia.busyAction) || authBusy}>
            {initia.busyAction ? 'Opening...' : 'Manage Wallet'}
          </button>
        )}

        <button
          type="button"
          className="btn btn-primary"
          disabled={!walletConnected || authBusy}
          onClick={onAuthenticate}
        >
          {authBusy ? 'Signing...' : user ? 'Sign In Again' : 'Sign In'}
        </button>
      </div>

      <p className="muted-small">
        Status: {walletConnected ? 'wallet connected' : 'wallet not connected'} · {user ? 'session active' : 'session missing'}
      </p>

      {(authError || initia.error) && <div className="error-banner">{authError || initia.error}</div>}
    </section>
  )
}
