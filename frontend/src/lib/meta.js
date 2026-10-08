/** Display metadata for the values the backend sends. Unknown values fall back to a prettified string. */
import { prettify } from './format'

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical']
export const RISK_LABEL = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }

// AlertStatus in schemas.py
export const ALERT_STATUSES = ['new', 'investigating', 'confirmed', 'false_positive', 'closed']
export const STATUS_LABEL = {
  new: 'New',
  investigating: 'Investigating',
  confirmed: 'Confirmed fraud',
  false_positive: 'False positive',
  closed: 'Closed',
}

// AlertFeedback in schemas.py. `result` mirrors FEEDBACK_TO_STATUS in routers/alerts.py.
export const FEEDBACK_OPTIONS = [
  { value: 'genuine_fraud', label: 'Genuine fraud', result: 'confirmed', tone: 'danger' },
  { value: 'suspicious', label: 'Suspicious', result: 'investigating', tone: 'neutral' },
  { value: 'under_investigation', label: 'Under investigation', result: 'investigating', tone: 'neutral' },
  { value: 'false_positive', label: 'False positive', result: 'false_positive', tone: 'good' },
]
export const FEEDBACK_LABEL = Object.fromEntries(FEEDBACK_OPTIONS.map((o) => [o.value, o.label]))

// TxnStatus in schemas.py
export const TXN_STATUSES = ['successful', 'failed', 'pending', 'reversed']
export const TXN_STATUS_LABEL = { successful: 'Successful', failed: 'Failed', pending: 'Pending', reversed: 'Reversed' }

export const CHANNEL_LABEL = {
  mobile_app: 'Mobile app',
  internet_banking: 'Internet banking',
  agent_banking: 'Agent banking',
  ussd: 'USSD',
  pos: 'POS',
}

export const ACCOUNT_TYPE_LABEL = { blaze_youth: 'Blaze youth', current: 'Current', savings: 'Savings' }

/**
 * Detector patterns (app/detection.py + app/pipeline.py). `desc` is one plain sentence for tooltips and legends.
 */
export const PATTERNS = {
  fan_in_collector: {
    label: 'Fan-in collector',
    desc: 'Received money from many different accounts within a short window.',
  },
  fan_in_feeder: {
    label: 'Fan-in feeder',
    desc: 'Sent money into an account that is collecting from many senders.',
  },
  cycle_member: {
    label: 'Circular transfers',
    desc: 'Part of a ring where funds travel through several accounts and return to an earlier one.',
  },
  shared_device_member: {
    label: 'Shared-device user',
    desc: 'Transacts from a device that several other accounts also use.',
  },
  shared_device: {
    label: 'Shared device',
    desc: 'A device used by many distinct accounts.',
  },
  rapid_passthrough: {
    label: 'Rapid pass-through',
    desc: 'Received money and sent most of it on again within minutes.',
  },
  statistical_anomaly: {
    label: 'Statistical anomaly',
    desc: 'Unusual behaviour flagged by the Isolation Forest that no rule caught.',
  },
  large_amount_anomaly: {
    label: 'Large-amount outlier',
    desc: 'Sent at least one transfer in the top 1% of all amounts seen.',
  },
}
export const patternLabel = (p) => PATTERNS[p]?.label ?? prettify(p)
export const patternDesc = (p) => PATTERNS[p]?.desc ?? ''

/**
 * The alerts endpoint filters with a case-insensitive substring match on `pattern`, so these
 * filter values intentionally group related patterns (e.g. "fan_in" matches collector and feeder).
 */
export const PATTERN_FILTERS = [
  { value: 'fan_in', label: 'Fan-in (collectors and feeders)', short: 'Fan-in' },
  { value: 'cycle', label: 'Circular transfers', short: 'Circular transfers' },
  { value: 'shared_device', label: 'Shared device (devices and users)', short: 'Shared device' },
  { value: 'rapid_passthrough', label: 'Rapid pass-through', short: 'Rapid pass-through' },
  { value: 'statistical_anomaly', label: 'Statistical anomaly', short: 'Statistical anomaly' },
]
