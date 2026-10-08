import { Link, useHrefWith } from '../lib/router'
import { isDeviceId } from '../lib/format'

export function AccountLink({ id, children }) {
  if (!id) return <span className="muted">–</span>
  return (
    <Link to={`/accounts/${encodeURIComponent(id)}`} className="idlink" onClick={(e) => e.stopPropagation()}>
      {children ?? id}
    </Link>
  )
}

/** There is no device endpoint, so a device links to the transactions made from it. */
export function DeviceLink({ id, children }) {
  if (!id) return <span className="muted">–</span>
  return (
    <Link
      to={`/transactions?device_id=${encodeURIComponent(id)}`}
      className="idlink"
      title="Transactions made from this device"
      onClick={(e) => e.stopPropagation()}
    >
      {children ?? id}
    </Link>
  )
}

/** Opens the transaction drawer on top of the current page (?txn=ID keeps it linkable). */
export function TxnLink({ id }) {
  const hrefWith = useHrefWith()
  return (
    <Link to={hrefWith({ txn: id })} className="idlink" onClick={(e) => e.stopPropagation()}>
      {id}
    </Link>
  )
}

/** Entity ids in the API carry no type, but device ids always start with DEV. */
export function EntityLink({ id, type }) {
  const device = type ? type === 'device' : isDeviceId(id)
  return device ? <DeviceLink id={id} /> : <AccountLink id={id} />
}
