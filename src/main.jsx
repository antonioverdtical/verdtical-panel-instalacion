import "./storage-shim.js";

// El id de instalación (?p=...) se lee UNA sola vez, al cargar el script —
// si el navegador restaura esta pestaña desde su caché de atrás/adelante
// (bfcache) en vez de cargarla de cero, la app puede seguir usando el id de
// la instalación anterior aunque la barra de direcciones ya muestre la
// nueva URL. "pageshow" con persisted=true detecta justo ese caso (solo
// bfcache lo dispara así) y fuerza una recarga real para que todo se
// vuelva a leer de la URL actual.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import LoginGate from './LoginGate.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
  </StrictMode>,
)