import Icon from './Icon'
import { fmtInt } from '../lib/format'

function pageWindow(page, pages) {
  const out = []
  const add = (v) => out.push(v)
  const near = new Set([1, pages, page - 1, page, page + 1])
  let last = 0
  for (let p = 1; p <= pages; p += 1) {
    if (!near.has(p)) continue
    if (p - last > 1) add('gap')
    add(p)
    last = p
  }
  return out
}

/** Page-number pager. `total` is `total_results` from the API. */
export default function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [25, 50, 100] }) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)

  return (
    <nav className="pager" aria-label="Pagination">
      <span className="num">
        {total === 0 ? 'No results' : `Showing ${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(total)}`}
      </span>
      <div className="pager__right">
        {onPageSize && (
          <label className="pager__size">
            Rows
            <select className="select" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        {pages > 1 && (
          <div className="pager__pages">
            <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
              <Icon name="chevron-left" size={16} />
            </button>
            {pageWindow(page, pages).map((p, i) =>
              p === 'gap' ? (
                <span key={`g${i}`} style={{ alignSelf: 'center', padding: '0 4px' }}>
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPage(p)}
                  aria-current={p === page ? 'page' : undefined}
                  className="num"
                >
                  {p}
                </button>
              ),
            )}
            <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
        )}
      </div>
    </nav>
  )
}
