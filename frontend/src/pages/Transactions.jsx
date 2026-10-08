import { api } from '../api/client'
import { Link, useQueryState, useHrefWith, useNavigate } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { usePageTitle, useUrlTextInput } from '../lib/hooks'
import { fmtDateTime, fmtInt, fmtNaira, toApiDateTime, toInt } from '../lib/format'
import { CHANNEL_LABEL, TXN_STATUSES, TXN_STATUS_LABEL } from '../lib/meta'
import { TxnStatusTag } from '../components/Badges'
import { AccountLink, DeviceLink } from '../components/EntityLinks'
import Pagination from '../components/Pagination'
import { EmptyState, ErrorState, SkeletonRows } from '../components/States'
import Icon from '../components/Icon'

const FILTER_KEYS = ['account_id', 'device_id', 'ip_address', 'min_amount', 'max_amount', 'date_from', 'date_to', 'status', 'flagged']

export default function Transactions() {
  usePageTitle('Transactions')
  const navigate = useNavigate()
  const hrefWith = useHrefWith()
  const [q, setQ] = useQueryState()
  const [accountInput, setAccountInput] = useUrlTextInput('account_id')
  const [deviceInput, setDeviceInput] = useUrlTextInput('device_id')
  const [ipInput, setIpInput] = useUrlTextInput('ip_address')
  const [minInput, setMinInput] = useUrlTextInput('min_amount')
  const [maxInput, setMaxInput] = useUrlTextInput('max_amount')

  const page = toInt(q.page, 1)
  const pageSize = toInt(q.size, 25)
  const hasFilters = FILTER_KEYS.some((k) => q[k])

  const params = {
    account_id: q.account_id,
    device_id: q.device_id,
    ip_address: q.ip_address,
    min_amount: q.min_amount,
    max_amount: q.max_amount,
    date_from: toApiDateTime(q.date_from),
    date_to: toApiDateTime(q.date_to),
    status: q.status,
    flagged: q.flagged === 'true' ? true : q.flagged === 'false' ? false : undefined,
    page,
    page_size: pageSize,
  }

  const { data, error, loading, reload } = useAsync(
    (signal) => api.listTransactions(params, signal),
    [
      q.account_id, q.device_id, q.ip_address, q.min_amount, q.max_amount,
      q.date_from, q.date_to, q.status, q.flagged, page, pageSize,
    ],
  )
  const txns = data?.transactions ?? []
  const set = (patch) => setQ({ ...patch, page: null })

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <p className="page-head__sub">
            {data ? `${fmtInt(data.total_results)} ${hasFilters ? 'matching ' : ''}transactions, newest first` : 'Loading transactions'}
          </p>
        </div>
      </div>

      <div className="panel" data-busy={loading && Boolean(data)}>
        <div className="filters">
          <div className="field">
            <label htmlFor="t-acc">Account ID (sender or receiver)</label>
            <input id="t-acc" className="input mono" value={accountInput} onChange={(e) => setAccountInput(e.target.value)} placeholder="ACC…" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="t-dev">Device ID</label>
            <input id="t-dev" className="input mono" value={deviceInput} onChange={(e) => setDeviceInput(e.target.value)} placeholder="DEV…" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="t-ip">IP address</label>
            <input id="t-ip" className="input mono" value={ipInput} onChange={(e) => setIpInput(e.target.value)} placeholder="e.g. 166.115.39.18" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="t-status">Status</label>
            <select id="t-status" className="select" value={q.status ?? ''} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All statuses</option>
              {TXN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TXN_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="t-flag">Flagged by detectors</label>
            <select id="t-flag" className="select" value={q.flagged ?? ''} onChange={(e) => set({ flagged: e.target.value })}>
              <option value="">Flagged and not flagged</option>
              <option value="true">Flagged only</option>
              <option value="false">Not flagged only</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="t-min">Minimum amount (₦)</label>
            <input id="t-min" className="input num" type="number" min="0" step="any" value={minInput} onChange={(e) => setMinInput(e.target.value)} placeholder="0" />
          </div>
          <div className="field">
            <label htmlFor="t-max">Maximum amount (₦)</label>
            <input id="t-max" className="input num" type="number" min="0" step="any" value={maxInput} onChange={(e) => setMaxInput(e.target.value)} placeholder="No limit" />
          </div>
          <div className="field">
            <label htmlFor="t-from">From (UTC)</label>
            <input id="t-from" className="input" type="datetime-local" value={q.date_from ?? ''} onChange={(e) => set({ date_from: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="t-to">To (UTC)</label>
            <input id="t-to" className="input" type="datetime-local" value={q.date_to ?? ''} onChange={(e) => set({ date_to: e.target.value })} />
          </div>
          {hasFilters && (
            <div className="filters__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setQ({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, null])), page: null })}
              >
                <Icon name="x" size={15} /> Clear filters
              </button>
            </div>
          )}
        </div>

        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonRows rows={10} />
        ) : txns.length === 0 ? (
          <EmptyState icon="search" title="No transactions match">
            Widen the amount or date range, or clear a filter.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="right">Amount</th>
                  <th>Time (UTC)</th>
                  <th>Channel</th>
                  <th>Device</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.txn_id} className="is-clickable" onClick={() => navigate(hrefWith({ txn: t.txn_id }))}>
                    <td>
                      <Link to={hrefWith({ txn: t.txn_id })} className="idlink" onClick={(e) => e.stopPropagation()}>
                        {t.txn_id}
                      </Link>
                    </td>
                    <td>
                      <AccountLink id={t.sender_account} />
                    </td>
                    <td>
                      <AccountLink id={t.receiver_account} />
                    </td>
                    <td className="right num nowrap" style={{ fontWeight: 600 }}>
                      {fmtNaira(t.amount)}
                    </td>
                    <td className="num nowrap">{fmtDateTime(t.timestamp)}</td>
                    <td className="nowrap">{t.channel ? (CHANNEL_LABEL[t.channel] ?? t.channel) : '–'}</td>
                    <td>{t.device_id ? <DeviceLink id={t.device_id} /> : <span className="muted">–</span>}</td>
                    <td>
                      <TxnStatusTag status={t.status} />
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
