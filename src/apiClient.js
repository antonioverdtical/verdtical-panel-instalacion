// Cliente para el backend real de Verdtical (lecturas de sensores en vivo).
// Si alguna variable falta o la llamada falla, se devuelve null y el panel
// sigue funcionando con la simulación local para esa línea.

const BASE_URL = import.meta.env.VITE_API_BASE_URL;
// El id de proyecto normalmente viene fijo por instalación (VITE_API_PROYECTO_ID,
// un despliegue de Vercel por cada una) — pero en el panel compartido
// (verdtical-panel.vercel.app) una única build sirve a cualquier instalación
// según el "?p=" de la URL, para no tener que crear un despliegue nuevo cada
// vez que se da de alta un proyecto. Central genera esa URL automáticamente.
const PROYECTO_ID = new URLSearchParams(window.location.search).get('p') || import.meta.env.VITE_API_PROYECTO_ID;

// Token de sesión de usuario (de POST /auth/login), en memoria — nunca en el
// código público. Lo rellena LoginGate tras un login válido.
let sessionToken = null;
export function setSessionToken(token) {
  sessionToken = token;
}
export function clearSessionToken() {
  sessionToken = null;
}

// LoginGate se suscribe aquí para forzar un logout cuando cualquier llamada
// devuelve 401 (sesión caducada o revocada en mitad de uso).
let onUnauthorized = () => {};
export function registerUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// URL del lanzador de instalaciones (verdtical-portal) — el botón "salir"
// de cada panel vuelve ahí, NO cierra la sesión: cada panel guarda su
// sesión en su propio origen (localStorage no se comparte entre dominios),
// así que ni tocarla ni recargar aquí afecta a la sesión del lanzador ni a
// la de otras instalaciones — el técnico entra, ve todas sus instalaciones,
// abre una, vuelve, y abre otra sin volver a escribir usuario/contraseña.
export const URL_LANZADOR = 'https://verdtical-portal.vercel.app';

function cabecerasAuth() {
  return { Authorization: `Bearer ${sessionToken}` };
}

// Normaliza nombres de línea para emparejar aunque haya pequeñas diferencias
// de formato entre el panel y el backend (espacios, mayúsculas, guiones):
// "Zona1", "Zona 1", "zona-1" se convierten todos en "zona1".
function normalizar(texto) {
  return String(texto || '').toLowerCase().replace(/[\s\-_]/g, '');
}

// GET /lecturas/general?proyecto_id=... — contador de agua GENERAL (antes
// del colector), si esta instalación tiene uno asignado. Independiente del
// caudal por línea — sirve para ver el consumo/fuga real de toda la
// instalación, no una suma calculada de las líneas activas.
export async function obtenerCaudalGeneral() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/lecturas/general?proyecto_id=${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// GET /lecturas/generales?proyecto_id=... — solo para instalaciones que
// reparten el agua en VARIOS colectores (opcional, ver Central "Contadores
// generales"). [] si esta instalación usa el contador único de siempre
// (obtenerCaudalGeneral) o no tiene ninguno configurado.
export async function obtenerContadoresGenerales() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/lecturas/generales?proyecto_id=${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// GET /lecturas/historial-diario?proyecto_id=...&dias=... — litros reales
// día a día, por línea, calculados en el servidor a partir de lo guardado
// (no depende de que el panel estuviera abierto justo al cambiar de día).
export async function obtenerHistorialDiario(dias) {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/lecturas/historial-diario?proyecto_id=${PROYECTO_ID}&dias=${dias || 30}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// GET /lecturas/historial-horario?linea_id=...&dia=... — litros reales
// de una línea, hora a hora, calculados en el servidor (no depende de que
// el panel estuviera abierto justo esa hora). dia en formato YYYY-MM-DD;
// si se omite, hoy.
export async function obtenerHistorialHorario(lineaId, dia) {
  if (!BASE_URL || !sessionToken || !lineaId) return null;
  try {
    const query = dia ? `linea_id=${lineaId}&dia=${dia}` : `linea_id=${lineaId}`;
    const res = await fetch(`${BASE_URL}/lecturas/historial-horario?${query}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function obtenerUltimasLecturas() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/lecturas/ultimas?proyecto_id=${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    const filas = await res.json();

    // Indexado por nombre normalizado de línea, para emparejar con sectors,
    // y también por posición (orden en que vienen del backend, que es el
    // orden en que se sincronizaron las Zonas reales) — por si los nombres
    // del panel no coinciden con los del backend (ej. "Línea 1" vs "Zona1").
    const porNombre = {};
    const porPosicion = [];
    for (const fila of filas) {
      const lectura = {
        humidity: fila.humedad !== null ? Number(fila.humedad) : null,
        temperature: fila.temperatura !== null ? Number(fila.temperatura) : null,
        ec: fila.ce !== null ? Number(fila.ce) : null,
        // Caudal instantáneo real (l/h) del contador de agua Loxone.
        flowMeasured: fila.caudal !== null ? Number(fila.caudal) : null,
        // Litros de hoy, ya calculados por el propio Loxone (no hay que
        // integrarlo nosotros a partir del caudal).
        litrosHoy: fila.litros_hoy !== null ? Number(fila.litros_hoy) : null,
        presion: fila.presion !== null ? Number(fila.presion) : null,
        medidoEn: fila.medido_en,
      };
      porNombre[normalizar(fila.nombre)] = lectura;
      porPosicion.push(lectura);
    }
    return { porNombre, porPosicion };
  } catch {
    return null;
  }
}

// Busca la lectura real de un sector del panel: primero por nombre (tolerando
// pequeñas diferencias de formato), y si no hay coincidencia, por posición
// (la línea nº N del panel con la línea nº N real del backend) — para paneles
// donde las líneas tienen nombres propios distintos a los del backend.
export function buscarLectura(lecturasReales, nombreSector, posicion) {
  if (!lecturasReales) return null;
  const porNombre = lecturasReales.porNombre?.[normalizar(nombreSector)];
  if (porNombre) return porNombre;
  if (typeof posicion === 'number') return lecturasReales.porPosicion?.[posicion] || null;
  return null;
}

// --- Configuración del proyecto (líneas, técnico/cliente, plano, ajustes) ---
// Mismo patrón defensivo que obtenerUltimasLecturas: si falta configuración o
// falla la llamada, se devuelve null y quien llama sigue usando localStorage.

// GET /proyectos/:id — ajustes generales (presión, ETo, fertilizante, etc.).
export async function obtenerConfiguracionProyecto() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/proyectos/${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// GET /lineas?proyecto_id=... — umbrales de alarma y posición en el plano de cada línea.
export async function obtenerLineasProyecto() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/lineas?proyecto_id=${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// GET /contactos?proyecto_id=... — técnico y cliente, indexados por rol.
export async function obtenerContactosProyecto() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/contactos?proyecto_id=${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    const filas = await res.json();
    return {
      tecnico: filas.find((f) => f.rol === 'tecnico') || null,
      cliente: filas.find((f) => f.rol === 'cliente') || null,
    };
  } catch {
    return null;
  }
}

// GET /planos?proyecto_id=... — imagen del plano (404 = todavía sin plano, se
// trata igual que cualquier otro fallo: null).
export async function obtenerPlanoProyecto() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/planos?proyecto_id=${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// GET /programas?proyecto_id=... — horarios de riego guardados de verdad.
export async function obtenerProgramasProyecto() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  try {
    const res = await fetch(`${BASE_URL}/programas?proyecto_id=${PROYECTO_ID}`, {
      headers: cabecerasAuth(),
    });
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Combina las llamadas anteriores en paralelo. Cada una ya se degrada
// a null por su cuenta, así que Promise.all nunca rechaza aquí.
export async function obtenerBootstrapProyecto() {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return null;
  const [proyecto, lineas, contactos, plano, programas, historialDiario] = await Promise.all([
    obtenerConfiguracionProyecto(),
    obtenerLineasProyecto(),
    obtenerContactosProyecto(),
    obtenerPlanoProyecto(),
    obtenerProgramasProyecto(),
    obtenerHistorialDiario(90),
  ]);
  return { proyecto, lineas, contactos, plano, programas, historialDiario };
}

// Busca la línea del backend que corresponde a un sector del panel: mismo
// emparejamiento por nombre normalizado, o si no por posición, que buscarLectura.
export function buscarLineaBackend(lineasBackend, nombreSector, posicion) {
  if (!Array.isArray(lineasBackend)) return null;
  const porNombre = lineasBackend.find((l) => normalizar(l.nombre) === normalizar(nombreSector));
  if (porNombre) return porNombre;
  if (typeof posicion === 'number') return lineasBackend[posicion] || null;
  return null;
}

// Guarda ajustes generales del proyecto (de momento solo alarmas_activas,
// pero sirve para cualquier campo que acepte PUT /proyectos/:id) — mismo
// motivo que guardarLineaBackend: sin esto, esta configuración solo vivía
// en el navegador y se perdía con cualquier "borrar datos del sitio".
export async function guardarAjustesProyecto(campos) {
  if (!BASE_URL || !sessionToken || !PROYECTO_ID) return { ok: false, error: 'no configurado' };
  try {
    const res = await fetch(`${BASE_URL}/proyectos/${PROYECTO_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cabecerasAuth() },
      body: JSON.stringify(campos),
    });
    if (res.status === 401) onUnauthorized();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Guarda en el backend la superficie/exposición/difusores/caudal de una
// línea real — hasta ahora estos campos SOLO vivían en localStorage del
// navegador (nunca se mandaban al servidor), así que un simple "borrar
// datos del sitio" los perdía para siempre sin posibilidad de recuperarlos.
// Usa el mismo PUT /lineas/:id que ya existía (el backend ya aceptaba estos
// campos, solo faltaba que el panel los mandara alguna vez).
export async function guardarLineaBackend(lineaId, campos) {
  if (!BASE_URL || !sessionToken || !lineaId) return { ok: false, error: 'no configurado' };
  try {
    const res = await fetch(`${BASE_URL}/lineas/${lineaId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cabecerasAuth() },
      body: JSON.stringify(campos),
    });
    if (res.status === 401) onUnauthorized();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Riego real (abre/cierra hardware) ---
// A diferencia de las funciones de arriba (datos de solo lectura, que
// pueden degradarse a null sin más), estas accionan una electroválvula real
// — quien llama necesita saber si de verdad se abrió/cerró, así que nunca
// fallan en silencio: siempre devuelven { ok, ...datos } o { ok: false, error }.

export async function abrirRiegoManual(lineaId) {
  if (!BASE_URL || !sessionToken || !lineaId) return { ok: false, error: 'no configurado' };
  try {
    const res = await fetch(`${BASE_URL}/riego/abrir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cabecerasAuth() },
      body: JSON.stringify({ linea_id: lineaId }),
    });
    if (res.status === 401) onUnauthorized();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function cerrarRiegoManual(lineaId) {
  if (!BASE_URL || !sessionToken || !lineaId) return { ok: false, error: 'no configurado' };
  try {
    const res = await fetch(`${BASE_URL}/riego/cerrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cabecerasAuth() },
      body: JSON.stringify({ linea_id: lineaId }),
    });
    if (res.status === 401) onUnauthorized();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Reemplaza de golpe todos los eventos de una línea+temporada — usado por el
// botón "Guardar programación" del editor estacional.
export async function guardarProgramacionTemporada(lineaId, temporada, eventos) {
  if (!BASE_URL || !sessionToken || !lineaId) return { ok: false, error: 'no configurado' };
  try {
    const res = await fetch(`${BASE_URL}/programas/linea/${lineaId}/temporada/${temporada}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cabecerasAuth() },
      body: JSON.stringify({ eventos }),
    });
    if (res.status === 401) onUnauthorized();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, eventos: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
