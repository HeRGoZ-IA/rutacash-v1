import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './styles/globals.css'
import { exposeReconciliationConsole } from '@/services/financialReconciliation'

// Diagnóstico financiero de SOLO LECTURA disponible en la consola del navegador:
//   await rutacash.diagnostico()       → informe legible
//   await rutacash.diagnosticoJSON()   → datos crudos
// No expone ninguna operación de escritura.
exposeReconciliationConsole()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
