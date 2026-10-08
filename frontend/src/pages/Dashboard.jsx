import { useMemo } from 'react'
import { api } from '../api/client'
import { Link, useNavigate } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { usePageTitle } from '../lib/hooks'
import { fmtDateTime, fmtInt, fmtPercent } from '../lib/format'
import { PATTERN_FILTERS, RISK_LEVELS, RISK_LABEL, patternLabel } from '../lib/meta'
import { RiskBadge } from '../components/Badges'
// recent_alerts rows carry no entity_type, so EntityLink picks account vs device from the id prefix
import { EntityLink } from '../components/EntityLinks'
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from '../components/States'
import Icon from '../components/Icon'

function RiskSpectrum({ distribution, total }) {
  return (
    <div>
      <div className="spectrum" role="img" aria-label="Accounts by risk level">
        {RISK_LEVELS.map((level) =>
          distribution[level] > 0 ? (
            <Link
              key={level}
              to={`/accounts?risk_level=${level}`}
              className="spectrum__seg"
              data-risk={level}
              style={{ flexGrow: distribution[level] }}
              title={`${RISK_LABEL[level]}: ${fmtInt(distribution[level])} accounts`}
            />
          ) : null,
        )}
      </div>
      <ul className="spectrum__legend">
        {RISK_LEVELS.map((level) => (
          <li key={level} data-risk={level}>
            <Link to={`/accounts?risk_level=${level}`}>
              <span className="spectrum__name">
                <i /> {RISK_LABEL[level]}
              </span>
              <span className="spectrum__count num">{fmtInt(distribution[level])}</span>
              <span className="spectrum__pct num">{fmtPercent(distribution[level], total)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Hero({ summary }) {
  const latest = summary.recent_alerts[0]
  return (
    <section className="hero">
      <div className="hero__main">
        <h1 className="hero__title">Fraud monitoring</h1>
        <div className="hero__figure">
          <span className="hero__big num">{fmtInt(summary.active_alerts)}</span>
          <span className="hero__caption">
            active alerts
            <small>New or being investigated</small>
          </span>
        </div>
        {latest && <p className="hero__meta">Most recent alert detected {fmtDateTime(latest.detected_at)} UTC</p>}
        <div className="row" style={{ marginTop: 18 }}>
          <Link to="/alerts?status=new" className="btn btn--light">
            Review new alerts
          </Link>
          <Link to="/alerts" className="btn btn--dark">
            All alerts
          </Link>
        </div>
      </div>

      <div className="hero__risk">
        <h2>Account risk</h2>
        <RiskSpectrum distribution={summary.risk_distribution} total={summary.total_accounts} />
      </div>

      <dl className="hero__stats">
        <div>
          <dt>Transactions monitored</dt>
          <dd className="num">{fmtInt(summary.total_transactions)}</dd>
        </div>
        <div>
          <dt>Accounts monitored</dt>
          <dd className="num">{fmtInt(summary.total_accounts)}</dd>
        </div>
        <div>
          <dt>High or critical risk accounts</dt>
          <dd className="num">{fmtInt(summary.high_risk_account_count)}</dd>
        </div>
      </dl>
    </section>
  )
}

function RecentAlerts({ alerts }) {
  const navigate = useNavigate()
  return (
    <div className="panel">
      <div className="panel__head">
        <h2>Recent alerts</h2>
        <Link to="/alerts" className="btn btn--sm btn--ghost">
          View all
          <Icon name="chevron-right" size={15} />
        </Link>
      </div>
      {alerts.length === 0 ? (
        <EmptyState title="No alerts yet">Alerts appear here once the detection pipeline has run.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Alert</th>
                <th>Entity</th>
                <th>Severity</th>
                <th>Detected (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr
                  key={a.alert_id}
                  className="is-clickable"
                  data-risk={a.severity}
                  onClick={() => navigate(`/alerts/${a.alert_id}`)}
                >
                  <td className="edge">
                    <div className="cell-stack">
                      <Link to={`/alerts/${a.alert_id}`} className="cell-title" onClick={(e) => e.stopPropagation()}>
                        {patternLabel(a.pattern)}
                      </Link>
                      <span className="cell-sub mono">{a.alert_id}</span>
                    </div>
                  </td>
                  <td>
                    <EntityLink id={a.entity_id} />
                  </td>
                  <td>
                    <RiskBadge level={a.severity} />
                  </td>
                  <td className="num nowrap">{fmtDateTime(a.detected_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Groups the open alerts (status new or investigating) by detector family. */
function OpenByPattern({ state }) {
  const rows = useMemo(() => {
    const list = state.data?.alerts ?? []
    const counts = new Map()
    for (const a of list) {
      if (a.status !== 'new' && a.status !== 'investigating') continue
      const fam = PATTERN_FILTERS.find((f) => a.pattern.includes(f.value))
      const key = fam ? fam.value : a.pattern
      const label = fam ? fam.short : patternLabel(a.pattern)
      const cur = counts.get(key) ?? { key, label, count: 0, linkable: Boolean(fam) }
      cur.count += 1
      counts.set(key, cur)
    }
    return [...counts.values()].sort((a, b) => b.count - a.count)
  }, [state.data])

  const max = rows[0]?.count ?? 1

  return (
    <section className="section">
      <div className="section__head">
        <h2>Open alerts by pattern</h2>
      </div>
      {state.loading && !state.data && <SkeletonRows rows={5} />}
      {state.error && <ErrorState error={state.error} onRetry={state.reload} />}
      {state.data && rows.length === 0 && <p className="muted" style={{ padding: '14px 0' }}>No open alerts.</p>}
      {rows.length > 0 && (
        <ul className="bars">
          {rows.map((r) => (
            <li key={r.key}>
              <Link to={r.linkable ? `/alerts?pattern=${r.key}` : '/alerts'} className="bars__row">
                <span className="bars__label">{r.label}</span>
                <span className="bars__track">
                  <span style={{ width: `${(r.count / max) * 100}%` }} />
                </span>
                <span className="bars__count num">{fmtInt(r.count)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function TopAccounts({ state }) {
  const accounts = state.data?.accounts ?? []
  return (
    <section className="section">
      <div className="section__head">
        <h2>Highest-risk accounts</h2>
        <Link to="/accounts" className="sub">
          View all
        </Link>
      </div>
      {state.loading && !state.data && <SkeletonRows rows={5} />}
      {state.error && <ErrorState error={state.error} onRetry={state.reload} />}
      {accounts.length > 0 && (
        <ul className="toplist">
          {accounts.map((a) => (
            <li key={a.account_id} data-risk={a.risk_level}>
              <Link to={`/accounts/${a.account_id}`} className="toplist__row">
                <span className="toplist__score num">{Math.round(a.risk_score)}</span>
                <span className="toplist__who">
                  <span className="cell-title">{a.owner_name}</span>
                  <span className="cell-sub mono">{a.account_id}</span>
                </span>
                <RiskBadge level={a.risk_level} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Dashboard() {
  usePageTitle('Dashboard')
  const summary = useAsync((signal) => api.dashboardSummary(signal), [])
  // The summary only lists 10 alerts, so the by-pattern breakdown reads the alert list itself.
  const alerts = useAsync((signal) => api.listAlerts({ limit: 1000 }, signal), [])
  const top = useAsync((signal) => api.listAccounts({ page_size: 6 }, signal), [])

  if (summary.error) return <ErrorState error={summary.error} onRetry={summary.reload} />

  if (!summary.data) {
    return (
      <div className="stack">
        <div className="hero hero--loading">
          <Skeleton height={20} width={180} style={{ opacity: 0.25 }} />
          <Skeleton height={84} width={220} style={{ opacity: 0.25, marginTop: 20 }} />
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <Hero summary={summary.data} />
      <div className="cols cols--main-aside dash-cols">
        <RecentAlerts alerts={summary.data.recent_alerts} />
        <div className="stack">
          <OpenByPattern state={alerts} />
          <TopAccounts state={top} />
        </div>
      </div>
    </div>
  )
}
