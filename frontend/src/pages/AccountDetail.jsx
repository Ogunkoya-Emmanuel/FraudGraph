import { useState } from 'react'
import { api } from '../api/client'
import { Link, useNavigate } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { usePageTitle } from '../lib/hooks'
import { fmtDate, fmtDateTime, fmtInt, fmtNaira } from '../lib/format'
import { ACCOUNT_TYPE_LABEL, patternDesc, patternLabel } from '../lib/meta'
import { RiskBadge, StatusTag } from '../components/Badges'
import { AccountLink, DeviceLink, TxnLink } from '../components/EntityLinks'
import { Meter, ScoreDial } from '../components/Gauges'
import { ErrorState, SkeletonRows } from '../components/States'
import NetworkPanel from '../components/graph/NetworkPanel'
import Icon from '../components/Icon'

function ChipList({ ids, render, limit = 10 }) {
  const [all, setAll] = useState(false)
  const shown = all ? ids : ids.slice(0, limit)
  return (
    <div className="chips" style={{ paddingTop: 14 }}>
      {shown.map((id) => (
        <span key={id}>{render(id)}</span>
      ))}
      {ids.length > limit && (
        <button type="button" className="chip chip--more" onClick={() => setAll((v) => !v)} style={{ cursor: 'pointer' }}>
          {all ? 'Show fewer' : `Show all ${fmtInt(ids.length)}`}
        </button>
      )}
    </div>
  )
}

export default function AccountDetail({ id }) {
  const navigate = useNavigate()
  const acc = useAsync((signal) => api.getAccount(id, signal), [id])
  const alerts = useAsync((signal) => api.listAlerts({ entity_id: id, limit: 50 }, signal), [id])
  const a = acc.data
  usePageTitle(a ? a.owner_name : 'Account')

  if (acc.error) {
    return (
      <>
        <Link to="/accounts" className="backlink">
          <Icon name="chevron-left" size={16} /> Accounts
        </Link>
        <div className="panel">
          <ErrorState error={acc.error} onRetry={acc.reload} title="Account not found" />
        </div>
      </>
    )
  }
  if (!a) {
    return (
      <div className="panel">
        <SkeletonRows rows={10} />
      </div>
    )
  }

  const accountAlerts = alerts.data?.alerts ?? []

  return (
    <>
      <Link to="/accounts" className="backlink">
        <Icon name="chevron-left" size={16} /> Accounts
      </Link>

      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 10, marginBottom: 8 }}>
            <RiskBadge level={a.risk_level} large />
            {a.account_type && <span className="chip">{ACCOUNT_TYPE_LABEL[a.account_type] ?? a.account_type} account</span>}
          </div>
          <h1>{a.owner_name}</h1>
          <p className="page-head__sub mono">{a.account_id}</p>
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => document.querySelector('.board')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            <Icon name="network" size={16} /> View network
          </button>
          <Link to={`/alerts?entity_id=${encodeURIComponent(a.account_id)}`} className="btn">
            <Icon name="alert" size={16} /> Alerts
          </Link>
          <Link to={`/transactions?account_id=${encodeURIComponent(a.account_id)}`} className="btn">
            <Icon name="swap" size={16} /> All transactions
          </Link>
        </div>
      </div>

      <div className="stack">
        <div className="cols cols--main-aside">
          <div className="panel" data-risk={a.risk_level}>
            <div className="panel__head">
              <h2>Risk assessment</h2>
            </div>
            <div className="panel__body stack">
              <div className="risk-top">
                <ScoreDial value={a.risk_score} level={a.risk_level} />
                <div className="stack stack--tight" style={{ flex: 1, minWidth: 220 }}>
                  <Meter
                    label="ML fraud probability"
                    value={a.ml_score}
                    color="var(--primary)"
                    hint="Random Forest, scored out-of-fold so the model never saw this account’s own label."
                  />
                  <Meter
                    label="Anomaly score"
                    value={a.anomaly_score}
                    color="var(--st-investigating)"
                    hint="Isolation Forest: how unusual this account’s behaviour is compared with all others."
                  />
                </div>
              </div>

              <section className="section">
                <div className="section__head">
                  <h2>Detected patterns</h2>
                  <span className="sub num">{a.flagged_patterns.length}</span>
                </div>
                {a.flagged_patterns.length === 0 ? (
                  <p className="muted" style={{ padding: '14px 0 4px' }}>
                    No detector flagged this account.
                  </p>
                ) : (
                  <ul className="patterns">
                    {a.flagged_patterns.map((p) => (
                      <li key={p}>
                        <span className="cell-title">{patternLabel(p)}</span>
                        <span className="muted">{patternDesc(p)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="section">
                <div className="section__head">
                  <h2>Why this account is flagged</h2>
                </div>
                {a.explanation.length === 0 ? (
                  <p className="muted" style={{ padding: '14px 0 4px' }}>
                    There is nothing to explain: no rule or model signal fired for this account.
                  </p>
                ) : (
                  <ul className="reasons">
                    {a.explanation.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>

          <div className="stack">
            <section className="section">
              <div className="section__head">
                <h2>Profile</h2>
              </div>
              <dl className="kv" style={{ paddingTop: 14 }}>
                <dt>Phone</dt>
                <dd className="num">{a.phone || '–'}</dd>
                <dt>City</dt>
                <dd>{a.city || '–'}</dd>
                <dt>Account type</dt>
                <dd>{a.account_type ? (ACCOUNT_TYPE_LABEL[a.account_type] ?? a.account_type) : '–'}</dd>
                <dt>Opened</dt>
                <dd className="num">{a.opened_date ? fmtDate(a.opened_date) : '–'}</dd>
              </dl>
            </section>

            <section className="section">
              <div className="section__head">
                <h2>Alerts on this account</h2>
                <span className="sub num">{alerts.data ? fmtInt(alerts.data.total_results) : ''}</span>
              </div>
              {alerts.loading && !alerts.data && <SkeletonRows rows={3} />}
              {alerts.error && <ErrorState error={alerts.error} onRetry={alerts.reload} />}
              {alerts.data && accountAlerts.length === 0 && (
                <p className="muted" style={{ padding: '14px 0' }}>
                  No alerts were raised for this account.
                </p>
              )}
              {accountAlerts.length > 0 && (
                <ul className="alertlist">
                  {accountAlerts.map((al) => (
                    <li key={al.alert_id} data-risk={al.severity}>
                      <Link to={`/alerts/${al.alert_id}`} className="alertlist__row">
                        <span className="alertlist__main">
                          <span className="cell-title">{patternLabel(al.pattern)}</span>
                          <span className="cell-sub mono">{al.alert_id}</span>
                        </span>
                        <StatusTag status={al.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>

        <NetworkPanel accountId={a.account_id} />

        <div className="cols cols--main-aside">
          <div className="panel">
            <div className="panel__head">
              <h2>Recent transactions</h2>
              <Link to={`/transactions?account_id=${encodeURIComponent(a.account_id)}`} className="sub">
                View all
              </Link>
            </div>
            {a.recent_transactions.length === 0 ? (
              <p className="muted" style={{ padding: 20 }}>
                No transactions for this account.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Direction</th>
                      <th>Counterparty</th>
                      <th className="right">Amount</th>
                      <th>Time (UTC)</th>
                      <th>Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.recent_transactions.map((t) => (
                      <tr key={t.txn_id}>
                        <td>
                          <span className={`dir dir--${t.direction}`}>
                            <Icon name={t.direction === 'in' ? 'arrow-down-left' : 'arrow-up-right'} size={15} />
                            {t.direction === 'in' ? 'Received' : 'Sent'}
                          </span>
                        </td>
                        <td>
                          <AccountLink id={t.counterparty} />
                        </td>
                        <td className="right num nowrap" style={{ fontWeight: 600 }}>
                          {fmtNaira(t.amount)}
                        </td>
                        <td className="num nowrap">{fmtDateTime(t.timestamp, { seconds: true })}</td>
                        <td>
                          <TxnLink id={t.txn_id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="stack">
            <section className="section">
              <div className="section__head">
                <h2>Devices used</h2>
                <span className="sub num">{fmtInt(a.connected_devices.length)}</span>
              </div>
              {a.connected_devices.length === 0 ? (
                <p className="muted" style={{ padding: '14px 0' }}>
                  No device recorded on outgoing transfers.
                </p>
              ) : (
                <ChipList ids={a.connected_devices} render={(d) => <DeviceLink id={d} />} />
              )}
            </section>
            <section className="section">
              <div className="section__head">
                <h2>Connected accounts</h2>
                <span className="sub num">{fmtInt(a.connected_accounts.length)}</span>
              </div>
              {a.connected_accounts.length === 0 ? (
                <p className="muted" style={{ padding: '14px 0' }}>
                  No counterparties yet.
                </p>
              ) : (
                <ChipList ids={a.connected_accounts} render={(c) => <AccountLink id={c} />} />
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  )
}
