import { useEffect, useRef } from 'react'
import { api } from '../api/client'
import { buildHref, Link, useRoute } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { CHANNEL_LABEL } from '../lib/meta'
import { fmtDateTime, fmtNaira } from '../lib/format'
import { AccountLink, DeviceLink } from './EntityLinks'
import { TxnStatusTag } from './Badges'
import { ErrorState, SkeletonRows } from './States'
import Icon from './Icon'

/**
 * Transaction detail (GET /transactions/{id}). Opened by adding ?txn=ID to any page,
 * so it can be linked to and the browser back button closes it.
 */
export default function TxnDrawer() {
  const { path, query, navigate } = useRoute()
  const txnId = query.txn
  const closeRef = useRef(null)

  const { data: t, error, loading, reload } = useAsync(
    (signal) => api.getTransaction(txnId, signal),
    [txnId],
    { enabled: Boolean(txnId) },
  )

  const close = () => {
    const rest = { ...query }
    delete rest.txn
    navigate(buildHref(path, rest), { replace: true })
  }
  const closeLatest = useRef(close)
  closeLatest.current = close

  useEffect(() => {
    if (!txnId) return undefined
    const t0 = setTimeout(() => closeRef.current?.focus(), 30)
    const onKey = (e) => e.key === 'Escape' && closeLatest.current()
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t0)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txnId, path])

  if (!txnId) return null

  return (
    <>
      <div className="overlay" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Transaction ${txnId}`}>
        <div className="drawer__head">
          <div>
            <h2>Transaction</h2>
            <div className="mono muted" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
              {txnId}
            </div>
          </div>
          <button ref={closeRef} type="button" className="iconbtn" onClick={close} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="drawer__body">
          {loading && !t && <SkeletonRows rows={8} />}
          {error && <ErrorState error={error} onRetry={reload} title="Transaction not found" />}
          {t && (
            <div className="stack">
              <div>
                <div className="num" style={{ fontSize: 34, fontWeight: 650, letterSpacing: '-0.02em' }}>
                  {fmtNaira(t.amount)}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <TxnStatusTag status={t.status} />
                  {t.flagged && (
                    <span className="badge" data-risk="high">
                      Flagged
                    </span>
                  )}
                </div>
              </div>

              {t.flagged && (
                <div className="notice notice--warn">
                  <Icon name="flag" size={16} />
                  <div>{t.flagged_reason || 'This transaction was flagged by a detector.'}</div>
                </div>
              )}

              <dl className="kv">
                <dt>From</dt>
                <dd>
                  <AccountLink id={t.sender_account} />
                </dd>
                <dt>To</dt>
                <dd>
                  <AccountLink id={t.receiver_account} />
                </dd>
                <dt>Time (UTC)</dt>
                <dd className="num">{fmtDateTime(t.timestamp, { seconds: true })}</dd>
                <dt>Channel</dt>
                <dd>{t.channel ? (CHANNEL_LABEL[t.channel] ?? t.channel) : '–'}</dd>
                <dt>Device</dt>
                <dd>{t.device_id ? <DeviceLink id={t.device_id} /> : '–'}</dd>
                <dt>IP address</dt>
                <dd>
                  {t.ip_address ? (
                    <Link
                      to={`/transactions?ip_address=${encodeURIComponent(t.ip_address)}`}
                      className="idlink"
                      title="Transactions from this IP address"
                    >
                      {t.ip_address}
                    </Link>
                  ) : (
                    '–'
                  )}
                </dd>
                <dt>Location</dt>
                <dd>{t.location || '–'}</dd>
              </dl>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
