import { RISK_LABEL, STATUS_LABEL, TXN_STATUS_LABEL, patternLabel, patternDesc } from '../lib/meta'
import { prettify } from '../lib/format'

export function RiskBadge({ level, large = false }) {
  const safe = level || 'low'
  return (
    <span className={`badge ${large ? 'badge--lg' : ''}`} data-risk={safe}>
      {RISK_LABEL[safe] ?? prettify(safe)}
    </span>
  )
}

export function StatusTag({ status, large = false }) {
  return (
    <span className={`tag ${large ? 'tag--lg' : ''}`} data-status={status}>
      {STATUS_LABEL[status] ?? prettify(status)}
    </span>
  )
}

export function TxnStatusTag({ status }) {
  return (
    <span className="tag" data-txn={status}>
      {TXN_STATUS_LABEL[status] ?? prettify(status)}
    </span>
  )
}

export function PatternChip({ pattern }) {
  return (
    <span className="chip" title={patternDesc(pattern)}>
      {patternLabel(pattern)}
    </span>
  )
}

/** Shows up to `max` pattern chips and a "+n" remainder. */
export function PatternChips({ patterns, max = 2 }) {
  const list = patterns ?? []
  if (!list.length) return <span className="muted">None</span>
  const shown = list.slice(0, max)
  const rest = list.length - shown.length
  return (
    <div className="chips">
      {shown.map((p) => (
        <PatternChip key={p} pattern={p} />
      ))}
      {rest > 0 && (
        <span className="chip chip--more" title={list.slice(max).map(patternLabel).join(', ')}>
          +{rest}
        </span>
      )}
    </div>
  )
}
