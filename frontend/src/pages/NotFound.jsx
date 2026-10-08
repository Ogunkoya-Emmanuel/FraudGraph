import { Link } from '../lib/router'
import { EmptyState } from '../components/States'
import { usePageTitle } from '../lib/hooks'

export default function NotFound() {
  usePageTitle('Page not found')
  return (
    <div className="panel">
      <EmptyState icon="search" title="Page not found" action={<Link to="/" className="btn btn--primary">Back to the dashboard</Link>}>
        That address doesn’t match any page in FraudGraph.
      </EmptyState>
    </div>
  )
}
