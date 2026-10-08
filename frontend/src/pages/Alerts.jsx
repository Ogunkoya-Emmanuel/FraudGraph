import { api } from '../api/client'
import { Link, useNavigate, useQueryState } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { usePageTitle, useUrlTextInput } from '../lib/hooks'
import { fmtDateTime, fmtInt, toInt } from '../lib/format'
import { ALERT_STATUSES, PATTERN_FILTERS, RISK_LEVELS, RISK_LABEL, STATUS_LABEL, patternLabel } from '../lib/meta'
import { RiskBadge, StatusTag } from '../components/Badges'
import { EntityLink } from '../components/EntityLinks'
import Pagination from '../components/Pagination'
import { EmptyState, ErrorState, SkeletonRows } from '../components/States'
import Icon from '../components/Icon'

export default function Alerts() {
  usePageTitle('Alerts')
  const navigate = useNavigate()
  const [q, setQ] = useQueryState()
  const [entityInput, setEntityInput] = useUrlTextInput('entity_id')

  const page = toInt(q.page, 1)
  const pageSize = toInt(q.size, 25)
  const filters = {
    severity: q.severity || undefined,
    status: q.status || undefined,
    pattern: q.pattern || undefined,
    entity_id: q.entity_id || undefined,
  }
  const hasFilters = Object.values(filters).some(Boolean)

  const { data, error, loading, reload } = useAsync(
    (signal) => api.listAlerts({ ...filters, limit: pageSize, offset: (page - 1) * pageSize }, signal),
    [q.severity, q.status, q.pattern, q.entity_id, page, pageSize],
  )

  const set = (patch) => setQ({ ...patch, page: null })
  const alerts = data?.alerts ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="page-head__sub">
            {data ? `${fmtInt(data.total_results)} ${hasFilters ? 'matching ' : ''}alerts, newest first` : 'Loading alerts'}
          </p>
        </div>
      </div>

      <div className="panel" data-busy={loading && Boolean(data)}>
        <div className="filters">
          <div className="field">
            <label htmlFor="f-sev">Severity</label>
            <select id="f-sev" className="select" value={q.severity ?? ''} onChange={(e) => set({ severity: e.target.value })}>
              <option value="">All severities</option>
              {RISK_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {RISK_LABEL[l]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" className="select" value={q.status ?? ''} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All statuses</option>
              {ALERT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-pattern">Pattern</label>
            <select id="f-pattern" className="select" value={q.pattern ?? ''} onChange={(e) => set({ pattern: e.target.value })}>
              <option value="">All patterns</option>
              {PATTERN_FILTERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              {q.pattern && !PATTERN_FILTERS.some((p) => p.value === q.pattern) && (
                <option value={q.pattern}>{patternLabel(q.pattern)}</option>
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-entity">Account or device ID</label>
            <input
              id="f-entity"
              className="input mono"
              value={entityInput}
              onChange={(e) => setEntityInput(e.target.value)}
              placeholder="Exact ID"
              spellCheck={false}
            />
          </div>
          {hasFilters && (
            <div className="filters__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setQ({ severity: null, status: null, pattern: null, entity_id: null, page: null })}
              >
                <Icon name="x" size={15} /> Clear filters
              </button>
            </div>
          )}
        </div>

        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonRows rows={8} />
        ) : alerts.length === 0 ? (
          <EmptyState title={hasFilters ? 'No alerts match these filters' : 'No alerts yet'}>
            {hasFilters ? 'Try removing a filter to widen the search.' : 'Alerts appear once the detection pipeline has run.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Alert</th>
                  <th>Entity</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Detected (UTC)</th>
                  <th className="right">Transactions</th>
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
                      <div className="cell-stack">
                        <EntityLink id={a.entity_id} type={a.entity_type} />
                        <span className="cell-sub">{a.entity_type === 'device' ? 'Device' : 'Account'}</span>
                      </div>
                    </td>
                    <td>
                      <RiskBadge level={a.severity} />
                    </td>
                    <td>
                      <StatusTag status={a.status} />
                    </td>
                    <td className="num nowrap">{fmtDateTime(a.detected_at)}</td>
                    <td className="right num">{fmtInt(a.related_transaction_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.total_results}
            onPage={(p) => setQ({ page: p === 1 ? null : p }, { replace: false })}
            onPageSize={(s) => setQ({ size: s === 25 ? null : s, page: null })}
          />
        )}
      </div>
    </>
  )
}
