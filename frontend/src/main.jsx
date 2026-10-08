import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Router } from './lib/router'
import { ToastProvider } from './components/Toast'
import App from './App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/pages.css'
import './styles/graph.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router>
      <ToastProvider>
        <App />
      </ToastProvider>
    </Router>
  </StrictMode>,
)
