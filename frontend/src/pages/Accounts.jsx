import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Link, useNavigate, useQueryState } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { usePageTitle, useUrlTextInput } from '../lib/hooks'
import { fmtInt, toInt } from '../lib/format'
import { ACCOUNT_TYPE_LABEL, RISK_LEVELS, RISK_LABEL } from '../lib/meta'
import { PatternChips, RiskBadge } from '../components/Badges'
import { MiniMeter } from '../components/Gauges'
import Pagination from '../components/Pagination'
import { EmptyState, ErrorState, SkeletonRows } from '../components/States'
import Icon from '../components/Icon'

/**
 * The API has no "list cities" endpoint and filters by exact city name, so suggestions are
 * collected by paging through /accounts once per session (200 per page, capped).
 */
let cityCache = null
function useCitySuggestions() {
  const [cities, setCities] = useState(cityCache ?? [])
  useEffect(() => {
    if (cityCache) return undefined
    const controller = new AbortController()
    ;(async () => {
      const found = new Set()
      try {
        for (let page = 1; page <= 10; page += 1) {
          const res = await api.listAccounts({ page, page_size: 200 }, controller.signal)
          res.accounts.forEach((a) => a.city && found.add(a.city))
          if (page * 200 >= res.total_results) break
        }
        cityCache = [...found].sort()
        setCities(cityCache)
      } catch {
        /* suggestions are a convenience; typing a city still works */
      }
    })()
    return () => controller.abort()
  }, [])
  return cities
}

export default function Accounts() {
  usePageTitle('Accounts')
  const navigate = useNavigate()
  const [q, setQ] = useQueryState()
  const [searchInput, setSearchInput] = useUrlTextInput('search')
  const [cityInput, setCityInput] = useUrlTextInput('city')
  const cities = useCitySuggestions()

  const page = toInt(q.page, 1)
  const pageSize = toInt(q.size, 25)
  const hasFilters = Boolean(q.search || q.risk_level || q.city)

  const { data, error, loading, reload } = useAsync(
    (signal) =>
      api.listAccounts(
        { search: q.search, risk_level: q.risk_level, city: q.city, page, page_size: pageSize },
        signal,
      ),
    [q.search, q.risk_level, q.city, page, pageSize],
  )
  const accounts = data?.accounts ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="page-head__sub">
            {data ? `${fmtInt(data.total_results)} ${hasFilters ? 'matching ' : ''}accounts, highest risk first` : 'Loading accounts'}
          </p>
        </div>
      </div>

      <div className="panel" data-busy={loading && Boolean(data)}>
        <div className="filters">
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label htmlFor="a-search">Search</label>
            <input
              id="a-search"
              className="input"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Account ID, owner name or phone"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label htmlFor="a-risk">Risk level</label>
            <select
              id="a-risk"
              className="select"
              value={q.risk_level ?? ''}
              onChange={(e) => setQ({ risk_level: e.target.value, page: null })}
            >
              <option value="">All levels</option>
              {RISK_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {RISK_LABEL[l]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="a-city">City</label>
            <input
              id="a-city"
              className="input"
              list="city-options"
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              placeholder="Exact city name"
            />
            <datalist id="city-options">
              {cities.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          {hasFilters && (
            <div className="filters__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setQ({ search: null, risk_level: null, city: null, page: null })}
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
        ) : accounts.length === 0 ? (
          <EmptyState icon="search" title="No accounts found">
            Check the spelling, or clear a filter. The search matches account ID, owner name and phone number.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Risk</th>
                  <th>Flagged patterns</th>
                  <th>City</th>
                  <th>Type</th>
                  <th title="Random Forest fraud probability, 0 to 100">ML score</th>
                  <th title="Isolation Forest anomaly score, 0 to 100">Anomaly</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr
                    key={a.account_id}
                    className="is-clickable"
                    data-risk={a.risk_level}
                    onClick={() => navigate(`/accounts/${a.account_id}`)}
                  >
                    <td className="edge">
                      <div className="cell-stack">
                        <Link to={`/accounts/${a.account_id}`} className="cell-title" onClick={(e) => e.stopPropagation()}>
                          {a.owner_name}
                        </Link>
                        <span className="cell-sub mono">{a.account_id}</span>
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
                        <span className="num" style={{ fontWeight: 650, width: 34, textAlign: 'right' }}>
                          {Number.isInteger(a.risk_score) ? a.risk_score : a.risk_score.toFixed(1)}
                        </span>
                        <RiskBadge level={a.risk_level} />
                      </div>
                    </td>
                    <td>
                      <PatternChips patterns={a.flagged_patterns} max={2} />
                    </td>
                    <td className="nowrap">{a.city || '–'}</td>
                    <td className="nowrap">{a.account_type ? (ACCOUNT_TYPE_LABEL[a.account_type] ?? a.account_type) : '–'}</td>
                    <td>
                      <MiniMeter value={a.ml_score} color="var(--primary)" />
                    </td>
                    <td>
                      <MiniMeter value={a.anomaly_score} color="var(--st-investigating)" />
                    </td>
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
            sizes={[25, 50, 100, 200]}
            onPage={(p) => setQ({ page: p === 1 ? null : p }, { replace: false })}
            onPageSize={(s) => setQ({ size: s === 25 ? null : s, page: null })}
          />
        )}
      </div>
    </>
  )
}
