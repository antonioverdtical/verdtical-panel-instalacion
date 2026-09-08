import { useEffect, useState } from 'react';
import { setSessionToken, clearSessionToken, registerUnauthorizedHandler } from './apiClient';

// Puerta de acceso: envuelve <App/> en main.jsx. No renderiza App hasta
// confirmar (contra el backend, no de forma optimista) que hay una sesión
// válida Y que esa sesión tiene acceso concedido a ESTA instalación en
// concreto (VITE_API_PROYECTO_ID) — distingue "no has iniciado sesión" de
// "tu usuario no tiene acceso a este panel", con pantallas distintas.

const BASE_URL = import.meta.env.VITE_API_BASE_URL;
// Mismo fallback que apiClient.js — ver ahí el porqué de "?p=".
const PROYECTO_ID = new URLSearchParams(window.location.search).get('p') || import.meta.env.VITE_API_PROYECTO_ID;
const STORAGE_KEY = 'vc_session';

function leerSesionGuardada() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function guardarSesion(sesion) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sesion));
}
function borrarSesionGuardada() {
  localStorage.removeItem(STORAGE_KEY);
}

// Cuando se llega desde Verdtical Central o el lanzador ya logueados, el
// token viaja como fragmento (#tok=...) — nunca como query string, porque el
// fragmento nunca sale del navegador (no va en la petición HTTP ni queda en
// logs de servidor). Se borra de la barra de direcciones en cuanto se lee,
// para que no quede ni en el historial ni en un enlace copiado.
function leerTokenDeFragmento() {
  const hash = window.location.hash || '';
  const match = hash.match(/(?:^#|&)tok=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
function limpiarFragmento() {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

const estilos = `
  .vg-root {
    --vc-bg: #12201f;
    --vc-panel: #1b2b2a;
    --vc-panel-2: #223533;
    --vc-border: #33463f;
    --vc-text: #ededE6;
    --vc-text-muted: #8fa39e;
    --vc-open: #6fcf97;
    --vc-red: #e0645b;
    --vc-font-display: 'Oswald', 'Arial Narrow', sans-serif;
    --vc-font-body: 'Inter', system-ui, sans-serif;
    --vc-font-mono: 'IBM Plex Mono', 'Courier New', monospace;
    min-height: 100vh;
    background: var(--vc-bg);
    color: var(--vc-text);
    font-family: var(--vc-font-body);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
    box-sizing: border-box;
  }
  .vg-root * { box-sizing: border-box; }
  .vg-card {
    width: 100%;
    max-width: 340px;
    background: var(--vc-panel);
    border: 1px solid var(--vc-border);
    border-radius: 12px;
    padding: 28px 24px;
    text-align: center;
  }
  .vg-title {
    font-family: var(--vc-font-display);
    font-size: 22px;
    letter-spacing: 0.02em;
    margin: 0 0 4px;
  }
  .vg-sub { font-size: 12px; color: var(--vc-text-muted); margin: 0 0 22px; }
  .vg-field { margin-bottom: 14px; text-align: left; }
  .vg-field label {
    display: block; font-size: 11px; color: var(--vc-text-muted);
    font-family: var(--vc-font-mono); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .vg-field input {
    width: 100%; background: var(--vc-panel-2); border: 1px solid var(--vc-border);
    color: var(--vc-text); border-radius: 8px; padding: 10px 12px; font-size: 15px;
    font-family: var(--vc-font-body);
  }
  .vg-field input:focus { outline: none; border-color: var(--vc-open); }
  .vg-btn {
    width: 100%; background: var(--vc-open); color: #0d1a19; border: none;
    border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600;
    font-family: var(--vc-font-body); cursor: pointer; margin-top: 6px;
  }
  .vg-btn:disabled { opacity: 0.6; cursor: default; }
  .vg-btn-outline {
    width: 100%; background: transparent; color: var(--vc-text-muted); border: 1px solid var(--vc-border);
    border-radius: 8px; padding: 12px; font-size: 14px; font-family: var(--vc-font-body); cursor: pointer; margin-top: 10px;
  }
  .vg-error { color: var(--vc-red); font-size: 12px; margin: 4px 0 0; min-height: 16px; }
  .vg-msg { font-size: 13px; color: var(--vc-text-muted); margin: 0 0 6px; }
`;

export default function LoginGate({ children }) {
  const [estado, setEstado] = useState('comprobando'); // comprobando | login | denegado | error | autorizado
  const [usuario, setUsuario] = useState('');
  const [password, setPassword] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [errorLogin, setErrorLogin] = useState('');

  async function comprobarAcceso(token) {
    try {
      const res = await fetch(`${BASE_URL}/auth/mis-instalaciones`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        borrarSesionGuardada();
        clearSessionToken();
        setEstado('login');
        return;
      }
      if (!res.ok) {
        setEstado('error');
        return;
      }
      const instalaciones = await res.json();
      const tieneAcceso = instalaciones.some((i) => String(i.id) === String(PROYECTO_ID));
      if (!tieneAcceso) {
        setEstado('denegado');
        return;
      }
      setSessionToken(token);
      setEstado('autorizado');
    } catch {
      setEstado('error');
    }
  }

  useEffect(() => {
    registerUnauthorizedHandler(() => {
      borrarSesionGuardada();
      clearSessionToken();
      setEstado('login');
    });
    const tokenDeFragmento = leerTokenDeFragmento();
    if (tokenDeFragmento) {
      limpiarFragmento();
      guardarSesion({ token: tokenDeFragmento });
      comprobarAcceso(tokenDeFragmento);
      return;
    }
    const sesion = leerSesionGuardada();
    if (sesion && sesion.token) {
      comprobarAcceso(sesion.token);
    } else {
      setEstado('login');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function enviarLogin(ev) {
    ev.preventDefault();
    setErrorLogin('');
    setEnviando(true);
    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: usuario.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorLogin(data.error || 'No se pudo iniciar sesión.');
        return;
      }
      guardarSesion({ token: data.token, usuario: data.usuario, expira_en: data.expira_en });
      await comprobarAcceso(data.token);
    } catch {
      setErrorLogin('No se pudo conectar con el servidor.');
    } finally {
      setEnviando(false);
    }
  }

  function cerrarSesion() {
    borrarSesionGuardada();
    clearSessionToken();
    setEstado('login');
  }

  if (estado === 'autorizado') return children;

  if (estado === 'comprobando') {
    return (
      <>
        <style>{estilos}</style>
        <div className="vg-root">
          <div className="vg-card">
            <p className="vg-msg">Comprobando sesión…</p>
          </div>
        </div>
      </>
    );
  }

  if (estado === 'denegado') {
    return (
      <>
        <style>{estilos}</style>
        <div className="vg-root">
          <div className="vg-card">
            <h1 className="vg-title">Sin acceso</h1>
            <p className="vg-sub">Tu usuario no tiene acceso a esta instalación. Contacta con Verdtical si crees que es un error.</p>
            <button className="vg-btn-outline" onClick={cerrarSesion}>Cambiar de usuario</button>
          </div>
        </div>
      </>
    );
  }

  if (estado === 'error') {
    return (
      <>
        <style>{estilos}</style>
        <div className="vg-root">
          <div className="vg-card">
            <h1 className="vg-title">Sin conexión</h1>
            <p className="vg-sub">No se pudo comprobar tu sesión. Comprueba tu conexión e inténtalo de nuevo.</p>
            <button className="vg-btn" onClick={() => setEstado('login')}>Reintentar</button>
          </div>
        </div>
      </>
    );
  }

  // estado === 'login'
  return (
    <>
      <style>{estilos}</style>
      <div className="vg-root">
        <div className="vg-card">
          <h1 className="vg-title">Verdtical</h1>
          <p className="vg-sub">Accede con tu usuario y contraseña</p>
          <form onSubmit={enviarLogin}>
            <div className="vg-field">
              <label htmlFor="vg-usuario">Usuario</label>
              <input
                id="vg-usuario"
                type="text"
                autoComplete="username"
                autoCapitalize="off"
                required
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
              />
            </div>
            <div className="vg-field">
              <label htmlFor="vg-password">Contraseña</label>
              <input
                id="vg-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <p className="vg-error">{errorLogin}</p>
            <button type="submit" className="vg-btn" disabled={enviando}>
              {enviando ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
