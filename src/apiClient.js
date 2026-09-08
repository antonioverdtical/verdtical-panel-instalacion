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
    const porId = {};
    for (const fila of filas) {
      const lectura = {
        // Id real de la línea en el backend. Antes se descartaba, y quien
        // llamaba no tenía más remedio que adivinar por nombre o por
        // posición — ver buscarLectura.
        lineaId: fila.linea_id,
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
      porId[fila.linea_id] = lectura;
    }
    return { porNombre, porPosicion, porId };
  } catch {
    return null;
  }
}

// Busca la lectura real de un sector del panel. El orden importa:
//
// 1) Por lineaBackendId — exacto. Es el emparejamiento que hace el resto
//    del panel (historial horario, programación) y el único que no puede
//    equivocarse de línea.
// 2) Por nombre normalizado, para sectores que todavía no tienen id.
// 3) Por posición, SOLO si no hay id. Es una suposición: depende de que el
//    backend devuelva las filas en el mismo orden que los sectores del
//    panel, cosa que nadie garantiza.
//
// Si el sector tiene id y no hay lectura para esa línea, se devuelve null
// en vez de caer a la posición. Antes esa caída hacía que un sector
// mostrara los datos de OTRA línea sin avisar — en Jarcia el panel decía
// que regaba la 2 mientras Loxone regaba la 6. Mejor un sector sin datos
// que un sector con los datos del vecino.
export function buscarLectura(lecturasReales, nombreSector, posicion, lineaBackendId) {
  if (!lecturasReales) return null;
  if (lineaBackendId != null) return lecturasReales.porId?.[lineaBackendId] || null;
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
    // Un año completo, no 90 días: la vista de "historial de 1 año" y la
    // comparativa mensual existen para ver el gasto de agua a lo largo del
    // año y cómo cambia con las estaciones, y con 90 días eso no se puede
    // mirar. El panel ya guarda hasta MAX_DIAS_HISTORICO (365) y el backend
    // admite hasta 365; era la petición la que se quedaba corta.
    obtenerHistorialDiario(365),
  ]);
  return { proyecto, lineas, contactos, plano, programas, historialDiario };
}

// Busca la línea del backend que corresponde a un sector del panel: mismo
// emparejamiento por nombre normalizado, o si no por posición, que buscarLectura.
// Empareja un sector del panel con su línea del backend. Igual que
// buscarLectura: el id manda, y la posición es el último recurso.
//
// Que el id vaya primero es lo que hace estable el emparejamiento. Antes,
// un sector cuyo nombre no casara se re-emparejaba por posición en CADA
// arranque: añadir o borrar una zona desplazaba a todos los sectores
// siguientes, en silencio y sin que nada lo delatara en pantalla.
export function buscarLineaBackend(lineasBackend, nombreSector, posicion, lineaBackendId) {
  if (!Array.isArray(lineasBackend)) return null;
  if (lineaBackendId != null) {
    // Si la zona emparejada ya no existe se devuelve null, no un sustituto:
    // el selector la mostrará como "sin emparejar", que es la verdad.
    return lineasBackend.find((l) => l.id === lineaBackendId) || null;
  }
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
// DELETE /lineas/:id — borra la línea en el servidor, no solo en esta
// pantalla. Hasta ahora el botón de eliminar solo la quitaba del estado
// local: volvía a aparecer al abrir desde otro móvil, tras borrar los datos
// del sitio o desde el panel compartido. En Galileo eso dejó tres zonas
// fantasma que nadie conseguía quitarse de encima.
//
// El backend borra en cascada las lecturas, programas, riegos y alarmas de
// esa línea, así que quien llame tiene que haber preguntado antes.
export async function borrarLineaBackend(lineaId) {
  if (!BASE_URL || !sessionToken || !lineaId) return { ok: false, error: 'no configurado' };
  try {
    const res = await fetch(`${BASE_URL}/lineas/${lineaId}`, {
      method: 'DELETE',
      headers: cabecerasAuth(),
    });
    if (res.status === 401) onUnauthorized();
    // 404 se acepta: si ya no está, el objetivo se ha cumplido igual.
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

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
