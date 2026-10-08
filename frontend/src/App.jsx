import { useEffect, useState, useSyncExternalStore } from 'react'
import { auth } from './api/client'
import { matchPath, useRoute } from './lib/router'
import TopBar from './components/TopBar'
import TxnDrawer from './components/TxnDrawer'
import ApiKeyModal from './components/ApiKeyModal'
import Dashboard from './pages/Dashboard'
import Alerts from './pages/Alerts'
import AlertDetail from './pages/AlertDetail'
import Accounts from './pages/Accounts'
import AccountDetail from './pages/AccountDetail'
import Transactions from './pages/Transactions'
import Cases from './pages/Cases'
import NotFound from './pages/NotFound'

// `keyOf` decides when a page remounts: detail pages reset when the id changes,
// while Cases keeps its list mounted as you move between cases.
const ROUTES = [
  { path: '/', el: Dashboard, keyOf: () => 'dashboard' },
  { path: '/alerts', el: Alerts, keyOf: () => 'alerts' },
  { path: '/alerts/:id', el: AlertDetail, keyOf: (p) => `alert-${p.id}` },
  { path: '/accounts', el: Accounts, keyOf: () => 'accounts' },
  { path: '/accounts/:id', el: AccountDetail, keyOf: (p) => `account-${p.id}` },
  { path: '/transactions', el: Transactions, keyOf: () => 'transactions' },
  { path: '/cases', el: Cases, keyOf: () => 'cases' },
  { path: '/cases/:id', el: Cases, keyOf: () => 'cases' },
]

export default function App() {
  const { path } = useRoute()
  const [keyOpen, setKeyOpen] = useState(false)
  const hasKey = useSyncExternalStore(auth.subscribe, auth.hasKey)

  useEffect(() => {
    const open = () => setKeyOpen(true)
    window.addEventListener('fraudgraph:auth-required', open)
    return () => window.removeEventListener('fraudgraph:auth-required', open)
  }, [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [path])

  let view = <NotFound />
  for (const r of ROUTES) {
    const params = matchPath(r.path, path)
    if (params) {
      const Page = r.el
      view = <Page key={r.keyOf(params)} {...params} />
      break
    }
  }

  return (
    <>
      <TopBar onOpenKey={() => setKeyOpen(true)} keyActive={hasKey} />
      <main className="page">{view}</main>
      <TxnDrawer />
      <ApiKeyModal open={keyOpen} onClose={() => setKeyOpen(false)} />
    </>
  )
}
