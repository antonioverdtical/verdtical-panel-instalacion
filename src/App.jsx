import React, { useState, useEffect, useRef } from "react";
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";
import {
  obtenerUltimasLecturas,
  obtenerCaudalGeneral,
  obtenerContadoresGenerales,
  buscarLectura,
  obtenerBootstrapProyecto,
  buscarLineaBackend,
  abrirRiegoManual,
  cerrarRiegoManual,
  guardarProgramacionTemporada,
  guardarLineaBackend,
  guardarAjustesProyecto,
  obtenerHistorialHorario,
  URL_LANZADOR,
} from "./apiClient";

const DIAS = [
  { key: "L", label: "Lun" },
  { key: "M", label: "Mar" },
  { key: "X", label: "Mié" },
  { key: "J", label: "Jue" },
  { key: "V", label: "Vie" },
  { key: "S", label: "Sáb" },
  { key: "D", label: "Dom" },
];
const DIA_JS_TO_KEY = ["D", "L", "M", "X", "J", "V", "S"];
const TODOS_LOS_DIAS = DIAS.map((d) => d.key);
const MAX_HORARIOS_POR_LINEA = 20;

const ESTACIONES = [
  { key: "primavera", label: "Primavera", factor: 0.75 },
  { key: "verano", label: "Verano", factor: 1 },
  { key: "otono", label: "Otoño", factor: 0.55 },
  { key: "invierno", label: "Invierno", factor: 0.3 },
];

// En el panel compartido (verdtical-panel.vercel.app) un mismo dispositivo
// puede visitar varias instalaciones distintas (?p=1, ?p=7...) — sin el id
// de proyecto en la clave, todas compartirían el mismo hueco de
// localStorage y se pisarían los datos entre sí. Mismo cálculo de "?p=" que
// apiClient.js/LoginGate.jsx.
const STORAGE_KEY_BASE = "verdtical-panel-riego-v6";
const PROYECTO_ID_STORAGE = new URLSearchParams(window.location.search).get("p") || import.meta.env.VITE_API_PROYECTO_ID;
const STORAGE_KEY = PROYECTO_ID_STORAGE ? `${STORAGE_KEY_BASE}-${PROYECTO_ID_STORAGE}` : STORAGE_KEY_BASE;

function getSeasonForDate(date) {
  const m = date.getMonth() + 1; // 1-12
  const d = date.getDate();
  if ((m === 3 && d >= 21) || m === 4 || m === 5 || (m === 6 && d <= 20)) return "primavera";
  if ((m === 6 && d >= 21) || m === 7 || m === 8 || (m === 9 && d <= 22)) return "verano";
  if ((m === 9 && d >= 23) || m === 10 || m === 11 || (m === 12 && d <= 20)) return "otono";
  return "invierno";
}

function nuevoHorario(overrides = {}) {
  return {
    id: `evt-${Date.now()}-${Math.round(Math.random() * 100000)}`,
    days: [...TODOS_LOS_DIAS],
    time: "06:00",
    duration: 15,
    ...overrides,
  };
}

// Conversión días de la semana: claves del panel ("L","M"...) <-> índices
// que usa programas_riego (0=domingo...6=sábado, mismo orden que
// DIA_JS_TO_KEY / Date.getDay()).
function diasKeyADiasSemana(days) {
  return (days || []).map((k) => DIA_JS_TO_KEY.indexOf(k)).filter((n) => n >= 0);
}
function diasSemanaADiasKey(diasSemana) {
  return (diasSemana || []).map((n) => DIA_JS_TO_KEY[n]).filter(Boolean);
}

// Fila de programas_riego (backend) -> evento del editor estacional (panel).
function mapProgramaFromApi(p) {
  return {
    id: `srv-${p.id}`,
    programaBackendId: p.id,
    days: diasSemanaADiasKey(p.dias_semana),
    time: String(p.hora_inicio).slice(0, 5),
    duration: p.duracion_minutos,
  };
}

// Agrupa las filas de /programas por línea+temporada y, para cada
// (línea, temporada) con datos reales, sustituye por completo el horario
// local de esa temporada por el del backend — porque a partir de ahora es
// lo que el riego automático ejecuta de verdad. Si el backend no tiene
// ninguna fila para una temporada de una línea, esa temporada se deja tal
// cual estaba localmente (autogenerada o editada a mano), pero queda
// "inerte" hasta que se guarde explícitamente.
function fusionarProgramacionConBackend(sector, programasBackend) {
  if (!sector.lineaBackendId || !Array.isArray(programasBackend)) return sector;
  const propios = programasBackend.filter((p) => p.linea_id === sector.lineaBackendId);
  if (propios.length === 0) return sector;

  const porTemporada = {};
  for (const p of propios) {
    const temporada = p.temporada || "todo_el_ano";
    if (!porTemporada[temporada]) porTemporada[temporada] = [];
    porTemporada[temporada].push(mapProgramaFromApi(p));
  }

  const schedules = { ...(sector.schedules || {}) };
  const schedulesGuardadas = { ...(sector.schedulesGuardadas || {}) };
  for (const [temporada, eventos] of Object.entries(porTemporada)) {
    if (temporada === "todo_el_ano") continue; // programas sin temporada, fuera del editor estacional
    schedules[temporada] = eventos;
    schedulesGuardadas[temporada] = true;
  }
  return { ...sector, schedules, schedulesGuardadas };
}

function escalarHorarios(eventos, factor) {
  return eventos.map((ev) => ({
    ...ev,
    id: `evt-${Date.now()}-${Math.round(Math.random() * 100000)}`,
    duration: Math.max(1, Math.round(ev.duration * factor)),
  }));
}

function generarProgramacionEstacional(eventosBase) {
  const schedules = {};
  ESTACIONES.forEach((est) => {
    schedules[est.key] = escalarHorarios(eventosBase, est.factor);
  });
  return schedules;
}

// Calcula automáticamente cuántos minutos de riego (repartidos en tandas
// cortas, tipo riego pulsado) necesita una línea al día, a partir de su
// superficie real, su exposición (que determina cuánta agua necesita por
// evapotranspiración) y el caudal real que da esa línea según sus emisores.
// La referencia es "verano" (factor 1); el resto de estaciones ya se ajustan
// solas a partir de ahí.
function calcularProgramacionAutomatica({ areaM2, eto, nominalFlow, duracionSesion, horaInicio, ocupacion }) {
  const necesidadDiariaLitros = Number(areaM2 || 0) * Number(eto || 0);
  if (necesidadDiariaLitros <= 0 || !nominalFlow || nominalFlow <= 0) return null;

  const tiempoTotalMin = (necesidadDiariaLitros / nominalFlow) * 60;
  // La duración de cada tanda la marca el "Riego 1" que ya tenga la línea
  // (o 15 min si todavía no hay ninguno configurado) — a partir de ahí se
  // calcula cuántas repeticiones de ESE mismo tamaño hacen falta para
  // completar el agua necesaria.
  const duracionPorSesion = Math.max(1, duracionSesion || 15);
  const numSesiones = Math.max(1, Math.ceil(tiempoTotalMin / duracionPorSesion));

  // La primera tanda respeta exactamente la hora que ya tenía puesta; el
  // resto se reparten a intervalos regulares a lo largo de las 24 horas
  // completas del día (dando la vuelta a medianoche si hace falta) — y si el
  // hueco propuesto choca con otra línea, lo va desplazando de 15 en 15 min
  // hasta encontrar uno libre (probando hasta 2h más tarde antes de
  // rendirse).
  const MINUTOS_DIA = 24 * 60;
  const inicioMin = (horaInicio ?? 7) * 60;
  const intervaloMin = Math.floor(MINUTOS_DIA / numSesiones);
  const diasTodos = [...TODOS_LOS_DIAS];
  let conflictosSinResolver = 0;
  // Ocupación propia de esta misma línea, para que sus propias tandas
  // tampoco se pisen entre sí (además de con las demás líneas).
  let ocupacionPropia = [];

  const horarios = [];
  for (let i = 0; i < numSesiones; i++) {
    const horaDeseada = (inicioMin + i * intervaloMin) % MINUTOS_DIA;
    const ocupacionTotal = [...(ocupacion || []), ...ocupacionPropia];
    let horaMin = horaDeseada;
    let conflicto = buscarConflicto(diasTodos, horaMin, duracionPorSesion, ocupacionTotal);
    // Busca en las 24 horas completas (pasos de 15 min), no solo un par de
    // horas después — si hay hueco en cualquier punto del día, lo encuentra.
    let intentos = 0;
    while (conflicto && intentos < MINUTOS_DIA / 15) {
      horaMin = (horaMin + 15) % MINUTOS_DIA;
      conflicto = buscarConflicto(diasTodos, horaMin, duracionPorSesion, ocupacionTotal);
      intentos++;
    }
    if (conflicto) conflictosSinResolver++;
    ocupacionPropia = [...ocupacionPropia, { days: diasTodos, inicio: horaMin, fin: horaMin + duracionPorSesion, lineName: "(misma línea)" }];
    const h = Math.floor(horaMin / 60);
    const m = horaMin % 60;
    horarios.push(
      nuevoHorario({
        time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        duration: duracionPorSesion,
      })
    );
  }

  return {
    horarios,
    necesidadDiariaLitros: Math.round(necesidadDiariaLitros * 10) / 10,
    tiempoTotalMin: Math.round(tiempoTotalMin),
    conflictosSinResolver,
  };
}

// Convierte "HH:MM" a minutos desde medianoche, para poder comparar rangos.
function horaAMinutos(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Todas las franjas ocupadas por las DEMÁS líneas (no la propia), para una
// estación concreta: [{ days, inicio, fin, lineName }, ...] en minutos.
function obtenerOcupacion(todosLosSectores, propioId, season) {
  if (!todosLosSectores) return [];
  const ocupacion = [];
  todosLosSectores.forEach((s) => {
    if (s.id === propioId) return;
    const eventosOtraLinea = (s.schedules && s.schedules[season]) || [];
    eventosOtraLinea.forEach((ev) => {
      const inicio = horaAMinutos(ev.time);
      ocupacion.push({ days: ev.days, inicio, fin: inicio + Number(ev.duration || 0), lineName: s.name });
    });
  });
  return ocupacion;
}

// ¿Este horario (días + inicio + duración) se cruza con alguna franja ya
// ocupada por otra línea? Solo cuenta si comparten al menos un día.
function buscarConflicto(dias, inicioMin, duracionMin, ocupacion) {
  const finMin = inicioMin + duracionMin;
  return ocupacion.find((o) => {
    const diasComunes = dias.some((d) => o.days.includes(d));
    if (!diasComunes) return false;
    return inicioMin < o.fin && finMin > o.inicio;
  });
}

// El balance hídrico (escorrentía/déficit) solo tiene sentido comparado con
// un día YA CERRADO — si se compara con "hoy" mientras el día todavía está en
// marcha, el riego que aún no ha llegado a ejecutarse parece "déficit" de
// forma falsa. Por eso usamos el consumo de AYER (el último día completo del
// histórico), no el de hoy.
function consumoDeAyer(sector, now) {
  const ayer = new Date(now);
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toDateString();
  const registro = (sector.dailyConsumption || []).find((d) => d.date === ayerStr);
  return registro ? Number(registro.liters || 0) : null;
}

// Construye el listado completo de todos los eventos de riego de todas las
// líneas, para una temporada, ordenados por hora — marcando cuáles se cruzan
// entre sí (mismo día de la semana y horas solapadas).
function construirListadoHorarios(sectors, season) {
  const eventosConLinea = [];
  sectors.forEach((s) => {
    const eventos = (s.schedules && s.schedules[season]) || [];
    eventos.forEach((ev) => {
      const inicio = horaAMinutos(ev.time);
      eventosConLinea.push({
        lineId: s.id,
        lineName: s.name,
        days: ev.days,
        time: ev.time,
        duration: Number(ev.duration || 0),
        inicio,
        fin: inicio + Number(ev.duration || 0),
      });
    });
  });
  eventosConLinea.sort((a, b) => a.inicio - b.inicio);

  // Para cada evento, buscamos si se cruza con OTRO evento de OTRA línea.
  const conConflicto = eventosConLinea.map((ev) => {
    const conflicto = eventosConLinea.find(
      (otro) =>
        otro.lineId !== ev.lineId &&
        otro.days.some((d) => ev.days.includes(d)) &&
        ev.inicio < otro.fin &&
        ev.fin > otro.inicio
    );
    return { ...ev, conflictoCon: conflicto ? conflicto.lineName : null };
  });

  return conConflicto;
}

// A partir del listado de eventos (ya construido), calcula los huecos
// libres del día completo (24h) en los que NINGUNA línea tiene programado
// riego — fusionando primero todos los intervalos ocupados, sin distinguir
// día de la semana (aproximación: si un evento existe en cualquier día, esa
// franja horaria se considera "ocupada" a efectos de huecos libres).
function calcularHuecosLibres(eventos) {
  if (eventos.length === 0) return [{ inicio: 0, fin: 24 * 60 }];
  const ordenados = [...eventos].sort((a, b) => a.inicio - b.inicio);
  const fusionados = [];
  ordenados.forEach((ev) => {
    const ultimo = fusionados[fusionados.length - 1];
    if (ultimo && ev.inicio <= ultimo.fin) {
      ultimo.fin = Math.max(ultimo.fin, ev.fin);
    } else {
      fusionados.push({ inicio: ev.inicio, fin: ev.fin });
    }
  });
  const huecos = [];
  let cursor = 0;
  fusionados.forEach((f) => {
    if (f.inicio > cursor) huecos.push({ inicio: cursor, fin: f.inicio });
    cursor = Math.max(cursor, f.fin);
  });
  if (cursor < 24 * 60) huecos.push({ inicio: cursor, fin: 24 * 60 });
  return huecos;
}

function formatoHora(min) {
  const m = ((min % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Calcula la programación de las 4 estaciones a la vez, PERO en vez de
// mantener el mismo número de tandas y encoger su duración (lo que las deja
// muy pegadas entre sí y aumenta el riesgo de que se pisen), mantiene el
// tamaño de cada tanda constante y reduce cuántas tandas hacen falta —
// menos necesidad de agua en invierno = menos repeticiones, no tandas más
// cortas. Cada estación comprueba conflictos por separado, con su propia
// ocupación (la ocupación de otras líneas puede ser distinta en cada
// estación si esas líneas también se han recalculado así).
function calcularProgramacionAutomaticaTodasEstaciones({ areaM2, etoBase, nominalFlow, duracionSesion, ocupacionPorEstacion, factoresEstacionales }) {
  const schedules = {};
  const resumenPorEstacion = {};
  ESTACIONES.forEach((est) => {
    const factor = (factoresEstacionales && factoresEstacionales[est.key]) ?? est.factor;
    const etoEstacional = etoBase * factor;
    const resultado = calcularProgramacionAutomatica({
      areaM2,
      eto: etoEstacional,
      nominalFlow,
      duracionSesion,
      horaInicio: 7,
      ocupacion: (ocupacionPorEstacion && ocupacionPorEstacion[est.key]) || [],
    });
    schedules[est.key] = resultado ? resultado.horarios : [nuevoHorario({ time: "07:00", duration: duracionSesion || 15 })];
    resumenPorEstacion[est.key] = resultado
      ? { numSesiones: resultado.horarios.length, conflictosSinResolver: resultado.conflictosSinResolver }
      : { numSesiones: 1, conflictosSinResolver: 0 };
  });
  return { schedules, resumenPorEstacion };
}

function sanearLineasAlCargar(sectors) {
  if (!sectors) return sectors;
  return sectors.map((s) => {
    const th = s.thresholds || {};
    const humedadObjetivo = th.humidityMin !== undefined && th.humidityMax !== undefined ? (th.humidityMin + th.humidityMax) / 2 : 45;
    const ecObjetivo = th.ecMin !== undefined && th.ecMax !== undefined ? (th.ecMin + th.ecMax) / 2 : 1.8;
    const sensors = s.sensors || {};
    return {
      ...s,
      sensors: {
        ...sensors,
        humidity: clamp(sensors.humidity ?? humedadObjetivo, humedadObjetivo - 10, humedadObjetivo + 10),
        ec: clamp(sensors.ec ?? ecObjetivo, ecObjetivo - 0.3, ecObjetivo + 0.3),
      },
      // Se reinician las banderas de aviso informativas (no las de fuga grave,
      // que reflejan un estado real ya visible en la interfaz) para partir de
      // una lectura limpia y evitar avisos heredados de sesiones anteriores.
      minorLeakFlag: false,
      clogFlag: false,
      humidityFlag: false,
      ecFlag: false,
      temperatureFlag: false,
    };
  });
}

// Rellena en un sector, campo a campo y solo donde falte localmente, los
// umbrales/posición en el plano que trae la línea correspondiente del
// backend. Nunca sobreescribe un valor que el sector ya tenga (localStorage
// manda siempre — ver Fase 2 del plan de unificación).
function fusionarLineaConBackend(s, l) {
  if (!l) return s;
  const th = s.thresholds || {};
  return {
    ...s,
    thresholds: {
      ...th,
      humidityMin: th.humidityMin ?? l.umbral_humedad_min ?? undefined,
      humidityMax: th.humidityMax ?? l.umbral_humedad_max ?? undefined,
      ecMin: th.ecMin ?? l.umbral_ec_min ?? undefined,
      ecMax: th.ecMax ?? l.umbral_ec_max ?? undefined,
      temperatureMin: th.temperatureMin ?? l.umbral_temperatura_min ?? undefined,
      temperatureMax: th.temperatureMax ?? l.umbral_temperatura_max ?? undefined,
      flowMinPercent: th.flowMinPercent ?? l.umbral_caudal_min_pct ?? undefined,
      flowMaxPercent: th.flowMaxPercent ?? l.umbral_caudal_max_pct ?? undefined,
    },
    posicionPlano: s.posicionPlano ?? (l.plano_pos_x != null ? { x: l.plano_pos_x, y: l.plano_pos_y } : undefined),
    // Al revés que el resto de este merge (donde local manda): estos 4
    // campos tienen su propio botón "guardar en el servidor" — su propósito
    // es justo que el servidor sea la fuente de verdad. Si local mandara
    // aquí, guardar en el servidor no serviría de nada en cuanto ese
    // navegador ya tuviera cualquier valor cacheado, por viejo que fuera
    // (así perdió Antonio una corrección real en Jarcia: el servidor tenía
    // el dato bueno, pero el panel seguía mostrando uno antiguo). Solo se usa
    // el valor local si el servidor todavía no tiene nada guardado — sirve
    // para no perder una edición hecha sin conexión, antes de guardarla.
    areaM2: l.superficie_m2 ?? s.areaM2 ?? undefined,
    exposicion: l.exposicion ?? s.exposicion ?? undefined,
    emitters: l.num_difusores ?? s.emitters ?? undefined,
    emitterFlow: l.caudal_difusor_lh ?? s.emitterFlow ?? undefined,
    // Id real de esta línea en el backend — identifica a qué línea corresponde
    // este sector para el riego manual real y la programación (ver apiClient.js).
    lineaBackendId: s.lineaBackendId ?? l.id,
  };
}

function demoHumedadSemana(humedadBase) {
  // Media diaria de humedad de ejemplo para los últimos 14 días (%), para el
  // historial de 1 año — complementa a demoHumedadHoraria, que cubre el
  // detalle real de los últimos 7 días.
  const dias = 14;
  const hoy = new Date();
  const lecturas = [];
  for (let diasAtras = dias; diasAtras >= 1; diasAtras--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    const avgHumidity = Math.round((humedadBase + (Math.random() - 0.5) * 4) * 10) / 10;
    lecturas.push({
      date: d.toDateString(),
      label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      avgHumidity,
    });
  }
  return lecturas;
}

function demoSensorHoraria(valorBase, amplitud, campo, decimales, min, max) {
  // Genera 168 lecturas reales de ejemplo (7 días x 24 horas) para cualquier
  // sensor, oscilando de forma natural alrededor de un valor base.
  const hoy = new Date();
  const lecturas = [];
  const factor = Math.pow(10, decimales);
  for (let diasAtras = 7; diasAtras >= 1; diasAtras--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    for (let h = 0; h < 24; h++) {
      const ciclo = Math.sin((h / 24) * Math.PI * 2) * amplitud;
      const ruido = (Math.random() - 0.5) * amplitud * 0.6;
      let valor = Math.round((valorBase + ciclo + ruido) * factor) / factor;
      if (min !== undefined) valor = Math.max(min, valor);
      if (max !== undefined) valor = Math.min(max, valor);
      lecturas.push({
        ts: new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).toISOString(),
        label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(h).padStart(2, "0") + "h",
        [campo]: valor,
      });
    }
  }
  return lecturas;
}

function demoSensorSemana(valorBase, amplitud, campo, decimales) {
  // Media diaria de ejemplo para los últimos 14 días, para el historial de 1 año.
  const dias = 14;
  const hoy = new Date();
  const factor = Math.pow(10, decimales);
  const lecturas = [];
  for (let diasAtras = dias; diasAtras >= 1; diasAtras--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    const valor = Math.round((valorBase + (Math.random() - 0.5) * amplitud) * factor) / factor;
    lecturas.push({
      date: d.toDateString(),
      label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      [campo]: valor,
    });
  }
  return lecturas;
}

function demoHumedadHoraria(humedadBase) {
  // 168 lecturas reales de ejemplo (7 días x 24 horas), sin promediar,
  // oscilando de forma natural alrededor de la humedad objetivo de la línea.
  const hoy = new Date();
  const lecturas = [];
  for (let diasAtras = 7; diasAtras >= 1; diasAtras--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    for (let h = 0; h < 24; h++) {
      const ciclo = Math.sin((h / 24) * Math.PI * 2) * 3;
      const ruido = Math.round((Math.random() - 0.5) * 4 * 10) / 10;
      const humidity = Math.max(20, Math.min(70, Math.round((humedadBase + ciclo + ruido) * 10) / 10));
      lecturas.push({
        ts: new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).toISOString(),
        label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(h).padStart(2, "0") + "h",
        humidity,
      });
    }
  }
  return lecturas;
}

function demoLineWeek(baseHour, litrosPorDia) {
  // Genera 14 días de ejemplo (los últimos 14 días naturales, terminando ayer),
  // tanto el total diario como su reparto por hora, concentrado en la franja
  // de riego habitual de esa línea (baseHour), para simular un riego corto.
  const hoy = new Date();
  const dailyConsumption = [];
  const hourlyHistory = [];
  litrosPorDia.forEach((litros, idx) => {
    const diasAtras = litrosPorDia.length - idx;
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    const dateKey = d.toDateString();
    dailyConsumption.push({
      date: dateKey,
      label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      liters: litros,
    });
    const hours = Array(24).fill(0);
    hours[baseHour] = Math.round(litros * 0.7 * 10) / 10;
    hours[(baseHour + 1) % 24] = Math.round(litros * 0.3 * 10) / 10;
    hourlyHistory.push({
      date: dateKey,
      label: d.toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short" }),
      hours,
    });
  });
  return { dailyConsumption, hourlyHistory };
}

function defaultSectors() {
  const numeros = [1, 2, 3, 4, 5, 6, 7, 8];
  // Posiciones calculadas a partir del plano real subido por Antonio
  // (Screenshot_20260820-184239.png): LÍNEA01-04 en la zona grande (49,43 m),
  // LÍNEA05-06 en la zona pequeña (19,38 m). El sensor se coloca a ~50 cm del
  // suelo, en la parte baja de los paneles, según indicó Antonio.
  const posicionesPlano = {
    // Zona grande (49,43 x 5,00 m), 2 filas x 2 mitades: cada línea cubre
    // (49,43/2) x (5,00/2) = 61,79 m². Zona pequeña (19,38 x 5,00 m), 2 filas
    // a todo el ancho: cada línea cubre 19,38 x (5,00/2) = 48,45 m².
    1: { tuberia: { x1: 4.2, y1: 18, x2: 50.0, y2: 22 }, sensor: { x: 15, y: 40 }, area: 61.79 },
    2: { tuberia: { x1: 50.4, y1: 18, x2: 96.7, y2: 22 }, sensor: { x: 85, y: 40 }, area: 61.79 },
    3: { tuberia: { x1: 4.2, y1: 27, x2: 50.0, y2: 31 }, sensor: { x: 35, y: 42 }, area: 61.79 },
    4: { tuberia: { x1: 50.4, y1: 27, x2: 96.7, y2: 31 }, sensor: { x: 65, y: 42 }, area: 61.79 },
    5: { tuberia: { x1: 32.5, y1: 56, x2: 69.5, y2: 60 }, sensor: { x: 40, y: 76 }, area: 48.45 },
    6: { tuberia: { x1: 32.5, y1: 66, x2: 69.5, y2: 70 }, sensor: { x: 60, y: 76 }, area: 48.45 },
    // 7 y 8: posición de plano PROVISIONAL (no viene del plano real subido),
    // solo para poder probar Zona7/Zona8 localmente — ajustar cuando se
    // añadan de verdad al panel.
    7: { tuberia: { x1: 4.2, y1: 36, x2: 50.0, y2: 40 }, sensor: { x: 15, y: 55 }, area: 48.45 },
    8: { tuberia: { x1: 50.4, y1: 36, x2: 96.7, y2: 40 }, sensor: { x: 85, y: 55 }, area: 48.45 },
  };
  return numeros.map((n, i) => {
    const baseHour = (i * 3) % 24;
    const litrosSemana = [18, 25, 14, 30, 22, 10, 27, 19, 23, 16, 28, 21, 12, 26].map(
      (l) => Math.round(l * (0.85 + (i % 4) * 0.1))
    );
    const semanaDemo = demoLineWeek(baseHour, litrosSemana);
    const pos = posicionesPlano[n];
    return {
      id: `sector-${n}`,
      name: `Línea ${n}`,
      mode: "horario",
      schedules: generarProgramacionEstacional([
        nuevoHorario({ time: `${String(baseHour).padStart(2, "0")}:00`, duration: 15 }),
      ]),
      thresholds: { humidityMin: 30, humidityMax: 65, ecMin: 1.2, ecMax: 2.4, temperatureMin: 2, temperatureMax: 40, flowMinPercent: 85, flowMaxPercent: 115 },
      sensors: {
        humidity: 45 + Math.round(Math.random() * 10 - 5),
        temperature: 21,
        ec: 1.8,
        flowMeasured: 0,
        litersToday: 0,
        lastResetDay: null,
      },
      posicionPlano: pos.sensor,
      duracionTandaAuto: 25,
      exposicion: "sol",
      hourlyConsumption: Array(24).fill(0),
      history: [],
      dailyConsumption: semanaDemo.dailyConsumption,
      hourlyHistory: semanaDemo.hourlyHistory,
      humidityHourlyHistory: demoHumedadHoraria(40 + (i % 4) * 3),
      humidityDailyHistory: demoHumedadSemana(40 + (i % 4) * 3),
      temperatureHourlyHistory: demoSensorHoraria(20 + (i % 3), 4, "temperature", 1),
      temperatureDailyHistory: demoSensorSemana(20 + (i % 3), 3, "avgTemperature", 1),
      ecHourlyHistory: demoSensorHoraria(1.8, 0.3, "ec", 2, 1.0, 3.0),
      ecDailyHistory: demoSensorSemana(1.8, 0.2, "avgEc", 2),
      flowHourlyHistory: demoSensorHoraria(0, 0, "flow", 0, 0, 0),
      flowDailyHistory: demoSensorSemana(0, 0, "avgFlow", 1),
      blockedByLeak: false,
      blockedByFault: false,
      minorLeakFlag: false,
      clogFlag: false,
      humidityFlag: false,
      ecFlag: false,
      temperatureFlag: false,
      manualOverride: null,
      riegoLog: [],
    };
  });
}

// Construye un sector directamente a partir de una línea real del backend
// (Loxone ya sincronizado) — a diferencia de defaultSectors(), no asume que
// haya exactamente 8 líneas ni usa las posiciones/áreas específicas del
// plano de Jarcia: usa el nombre y los datos reales de esa línea (Zona1,
// Zona2...) tal cual, y arranca sin historial inventado — se rellena solo
// con lecturas reales a partir de aquí. Se usa en el primer arranque de una
// instalación nueva (sin nada en localStorage todavía) que ya tiene Loxone
// conectado, para que el número de líneas en el panel coincida siempre con
// el número real de líneas sincronizadas, sea cual sea.
function construirSectorDesdeLineaBackend(l, indice) {
  return {
    id: `sector-${l.id}`,
    name: l.nombre,
    mode: "horario",
    schedules: generarProgramacionEstacional([
      nuevoHorario({ time: `${String((indice * 3) % 24).padStart(2, "0")}:00`, duration: 15 }),
    ]),
    thresholds: {
      humidityMin: l.umbral_humedad_min ?? 30,
      humidityMax: l.umbral_humedad_max ?? 65,
      ecMin: l.umbral_ec_min ?? 1.2,
      ecMax: l.umbral_ec_max ?? 2.4,
      temperatureMin: l.umbral_temperatura_min ?? 2,
      temperatureMax: l.umbral_temperatura_max ?? 40,
      flowMinPercent: l.umbral_caudal_min_pct ?? 85,
      flowMaxPercent: l.umbral_caudal_max_pct ?? 115,
    },
    sensors: { humidity: 0, temperature: 0, ec: 0, flowMeasured: 0, litersToday: 0, lastResetDay: null },
    posicionPlano: l.plano_pos_x != null ? { x: l.plano_pos_x, y: l.plano_pos_y } : undefined,
    areaM2: l.superficie_m2 ?? undefined,
    exposicion: l.exposicion ?? "sol",
    emitters: l.num_difusores ?? undefined,
    emitterFlow: l.caudal_difusor_lh ?? undefined,
    duracionTandaAuto: 25,
    hourlyConsumption: Array(24).fill(0),
    history: [],
    dailyConsumption: [],
    hourlyHistory: [],
    humidityHourlyHistory: [],
    humidityDailyHistory: [],
    temperatureHourlyHistory: [],
    temperatureDailyHistory: [],
    ecHourlyHistory: [],
    ecDailyHistory: [],
    flowHourlyHistory: [],
    flowDailyHistory: [],
    blockedByLeak: false,
    blockedByFault: false,
    minorLeakFlag: false,
    clogFlag: false,
    humidityFlag: false,
    ecFlag: false,
    temperatureFlag: false,
    manualOverride: null,
    riegoLog: [],
    lineaBackendId: l.id,
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Convierte las filas de GET /lecturas/historial-diario (linea_id, nombre,
// dia, litros) en un mapa por día — total de la instalación y desglose por
// línea — con el mismo formato de "date"/"label" que ya usa el resto del
// panel (demoDailyConsumption, day-rollover local, etc.) para que un día
// real y uno de la demo se puedan mezclar/buscar por "date" sin distinguir
// de dónde vino.
function transformarHistorialDiario(filas) {
  const porDia = {};
  (filas || []).forEach((f) => {
    const d = new Date(f.dia);
    const dateStr = d.toDateString();
    if (!porDia[dateStr]) {
      porDia[dateStr] = {
        date: dateStr,
        label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
        total: 0,
        porLinea: {},
      };
    }
    const litros = Number(f.litros || 0);
    porDia[dateStr].total += litros;
    porDia[dateStr].porLinea[f.linea_id] = litros;
  });
  return Object.values(porDia).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function demoDailyConsumption() {
  const litrosSemana = [100, 180, 300, 250, 50, 75, 35, 120, 210, 280, 90, 60, 150, 200];
  const hoy = new Date();
  return litrosSemana.map((liters, idx) => {
    const diasAtras = litrosSemana.length - idx;
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    return {
      date: d.toDateString(),
      label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      liters,
    };
  });
}

function demoFertilizerHistory() {
  // Consumo de fertilizante de ejemplo repartido entre los últimos 14 días.
  const mlSemana = [4200, 3800, 2900, 3500, 4100, 3300, 3200, 3900, 3600, 2700, 3400, 4000, 3100, 3300];
  const hoy = new Date();
  return mlSemana.map((consumoML, idx) => {
    const diasAtras = mlSemana.length - idx;
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    return {
      date: d.toDateString(),
      label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      consumoML,
    };
  });
}

function demoPressureHistory() {
  // Media diaria de presión de ejemplo para los últimos 14 días (bar).
  const presionSemana = [2.4, 2.6, 2.3, 2.7, 2.5, 2.2, 2.6, 2.5, 2.3, 2.6, 2.4, 2.7, 2.2, 2.5];
  const hoy = new Date();
  return presionSemana.map((avgPressure, idx) => {
    const diasAtras = presionSemana.length - idx;
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    return {
      date: d.toDateString(),
      label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
      avgPressure,
    };
  });
}

function demoPressureHourly() {
  // 168 lecturas reales de ejemplo (7 días x 24 horas), sin promediar,
  // con una ligera bajada simulada durante las horas de riego habituales.
  const hoy = new Date();
  const lecturas = [];
  for (let diasAtras = 7; diasAtras >= 1; diasAtras--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - diasAtras);
    for (let h = 0; h < 24; h++) {
      const bajadaRiego = h % 3 === 0 ? 0.15 : 0; // pequeñas caídas cuando suele regar alguna línea
      const ruido = Math.round((Math.random() - 0.5) * 0.2 * 100) / 100;
      const pressure = Math.round((2.6 - bajadaRiego + ruido) * 100) / 100;
      lecturas.push({
        ts: new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).toISOString(),
        label: d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(h).padStart(2, "0") + "h",
        pressure,
      });
    }
  }
  return lecturas;
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function eventosDeTemporada(sector, now) {
  const season = getSeasonForDate(now);
  return (sector.schedules && sector.schedules[season]) || [];
}

function isWithinSchedule(sector, now) {
  const events = eventosDeTemporada(sector, now);
  const todayKey = DIA_JS_TO_KEY[now.getDay()];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return events.some((ev) => {
    if (!ev.days || !ev.days.includes(todayKey)) return false;
    const start = timeToMinutes(ev.time);
    const end = start + Number(ev.duration || 0);
    return nowMin >= start && nowMin < end;
  });
}

function isManualOverrideActive(sector, now) {
  const mo = sector.manualOverride;
  if (!mo || !mo.active) return false;
  return new Date(mo.endsAt).getTime() > now.getTime();
}

function isSectorActiveNow(sector, now) {
  if (sector.blockedByLeak || sector.blockedByFault) return false;
  if (isManualOverrideActive(sector, now)) return true;
  if (sector.mode === "apagado") return false;
  const scheduled = isWithinSchedule(sector, now);
  if (sector.mode === "sensor") {
    if (!scheduled) return false;
    const th = sector.thresholds || { humidityMin: 30 };
    const humidity = sector.sensors ? sector.sensors.humidity : undefined;
    if (humidity === undefined) return true;
    return humidity < th.humidityMin;
  }
  return scheduled;
}

function nextEventForSector(sector, now) {
  if (sector.mode === "apagado") return null;
  const events = eventosDeTemporada(sector, now);
  let earliest = null;
  events.forEach((ev) => {
    if (!ev.days || ev.days.length === 0) return;
    const startMin = timeToMinutes(ev.time);
    for (let offset = 0; offset < 8; offset++) {
      const d = new Date(now);
      d.setDate(d.getDate() + offset);
      const key = DIA_JS_TO_KEY[d.getDay()];
      if (!key || !ev.days.includes(key)) continue;
      const candidate = new Date(d);
      candidate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      if (candidate.getTime() > now.getTime()) {
        if (!earliest || candidate.getTime() < earliest.getTime()) earliest = candidate;
        break;
      }
    }
  });
  return earliest;
}

function formatEventDate(date, now) {
  if (!date) return "sin programar";
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  if (sameDay) return `hoy · ${hh}:${mm}`;
  if (isTomorrow) return `mañana · ${hh}:${mm}`;
  const diaLabel = DIAS[(date.getDay() + 6) % 7].label;
  return `${diaLabel} · ${hh}:${mm}`;
}

// Calcula el domingo de Pascua para un año dado (algoritmo de Gauss), para
// poder situar el Viernes Santo, que es festivo nacional pero cambia de
// fecha cada año.
function domingoPascua(anio) {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(anio, mes - 1, dia);
}

// Festivos nacionales de España — los de fecha fija, más el Viernes Santo
// (móvil, calculado a partir de la Pascua). No incluye festivos autonómicos
// ni locales, que varían según la ubicación de cada instalación.
function esFestivoNacional(fecha) {
  const mes = fecha.getMonth() + 1;
  const dia = fecha.getDate();
  const fijos = [
    [1, 1], // Año Nuevo
    [1, 6], // Reyes
    [5, 1], // Fiesta del Trabajo
    [8, 15], // Asunción
    [10, 12], // Fiesta Nacional de España
    [11, 1], // Todos los Santos
    [12, 6], // Día de la Constitución
    [12, 8], // Inmaculada Concepción
    [12, 25], // Navidad
  ];
  if (fijos.some(([m, d]) => m === mes && d === dia)) return true;
  const pascua = domingoPascua(fecha.getFullYear());
  const viernesSanto = new Date(pascua);
  viernesSanto.setDate(pascua.getDate() - 2);
  return fecha.getFullYear() === viernesSanto.getFullYear() && mes === viernesSanto.getMonth() + 1 && dia === viernesSanto.getDate();
}

// Avanza la fecha, día a día, hasta caer en un día laborable (ni fin de
// semana ni festivo nacional).
function siguienteDiaLaborable(fecha) {
  const d = new Date(fecha);
  while (d.getDay() === 0 || d.getDay() === 6 || esFestivoNacional(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

const MESES_POR_FRECUENCIA = {
  mensual: 1,
  bimensual: 2,
  trimestral: 3,
  cuatrimestral: 4,
  semestral: 6,
};

// Calcula la próxima fecha de mantenimiento a partir de una fecha base y la
// frecuencia contratada, ajustando hacia adelante si cae en fin de semana o
// festivo nacional.
function calcularProximoMantenimiento(fechaBase, frecuencia) {
  const meses = MESES_POR_FRECUENCIA[frecuencia] || 1;
  const d = new Date(fechaBase);
  d.setMonth(d.getMonth() + meses);
  return siguienteDiaLaborable(d);
}

// Genera todas las fechas de mantenimiento programadas dentro del año en
// curso, empezando por la próxima fecha ya calculada y repitiendo hacia
// adelante según la frecuencia, hasta que se sale del año.
function fechasMantenimientoDelAnio(fechaInicio, frecuencia) {
  const anio = new Date().getFullYear();
  const fechas = [];
  let cursor = new Date(fechaInicio);
  let vueltas = 0;
  while (cursor.getFullYear() === anio && vueltas < 24) {
    fechas.push(new Date(cursor));
    cursor = calcularProximoMantenimiento(cursor, frecuencia);
    vueltas++;
  }
  return fechas;
}

const CATALOGO_PROCESOS_MANTENIMIENTO = [
  {
    key: "fertilizante",
    label: "Rellenar fertilizante",
    detalle:
      "Se ha revisado y rellenado el depósito de fertirrigación, comprobando la dosificación para asegurar el aporte nutricional correcto de las plantas en las próximas semanas.",
  },
  {
    key: "limpieza_canal",
    label: "Limpieza de canal",
    detalle:
      "Se ha limpiado el canal y los puntos de recogida de agua, retirando hojas, tierra y posibles restos que pudieran obstruir el drenaje de la instalación.",
  },
  {
    key: "cambio_plantas",
    label: "Cambio de plantas",
    detalle:
      "Se han sustituido los ejemplares en mal estado o marchitos por plantas nuevas, manteniendo la densidad y el aspecto visual conjunto del jardín.",
  },
  {
    key: "limpieza_plantas",
    label: "Limpieza de plantas",
    detalle:
      "Se ha realizado limpieza y poda de mantenimiento de la vegetación: retirada de hojas secas, restos vegetales y pequeños ajustes de forma para favorecer un crecimiento sano.",
  },
  {
    key: "fitosanitario",
    label: "Tratamiento fitosanitario",
    detalle:
      "Se ha aplicado un tratamiento fitosanitario a la vegetación, como medida preventiva o correctiva frente a plagas y enfermedades comunes en este tipo de instalación.",
  },
  {
    key: "revision_general",
    label: "Revisión general del sistema",
    detalle:
      "Se ha realizado una revisión completa del sistema de riego: electroválvulas, sensores, presión de red y funcionamiento individual de cada línea, comprobando que todo opera con normalidad.",
  },
];

const CATEGORIAS_ALARMA = [
  { key: "fugas", label: "Fugas (leve y grave)" },
  { key: "fallo_electrico", label: "Fallo eléctrico de electroválvula" },
  { key: "embozo", label: "Posible embozo" },
  { key: "presion", label: "Presión de red" },
  { key: "humedad", label: "Humedad fuera de rango" },
  { key: "ec", label: "CE fuera de rango" },
  { key: "temperatura", label: "Temperatura fuera de rango" },
  { key: "multiples_lineas", label: "Varias líneas a la vez" },
  { key: "fertilizante", label: "Nivel de fertilizante" },
  { key: "maestra", label: "Rotura antes de las electroválvulas (maestra)" },
  { key: "corte_corriente", label: "Corte de corriente en el PLC" },
  { key: "sin_datos", label: "Sin datos / comunicación perdida" },
  { key: "sin_agua", label: "Sin agua en la red" },
  { key: "riego_excesivo", label: "Riego excesivo (escorrentía)" },
];

// IMPORTANTE PARA LA FUTURA INTEGRACIÓN CON mapa-situacion-proyectos.html:
// esta función es el punto de traducción entre los dos sistemas. El "tipo"
// exacto de una alarma aquí (p.ej. "humedad_fuera_rango") se corresponde con
// el "tipoAlarma" que usa el mapa multi-proyecto (p.ej. "humedad") a través
// de esta categoría, NO por coincidencia directa de campo. Cuando exista un
// backend real, el evento que se envíe al mapa debe llevar
// categoriaDeAlarma(alarm.type) en su campo tipoAlarma, no alarm.type tal cual.
function categoriaDeAlarma(type) {
  if (type === "fuga_grave" || type === "fuga_leve" || type === "fuga_rearmada") return "fugas";
  if (type === "fallo_electrico" || type === "fallo_electrico_resuelto") return "fallo_electrico";
  if (type === "embozo") return "embozo";
  if (type === "presion_baja" || type === "presion_alta") return "presion";
  if (type === "humedad_fuera_rango") return "humedad";
  if (type === "ec_fuera_rango") return "ec";
  if (type === "temperatura_fuera_rango") return "temperatura";
  if (type === "multiples_lineas") return "multiples_lineas";
  if (type === "fertilizante_bajo" || type === "fertilizante_agotado" || type === "fertilizante_rellenado") return "fertilizante";
  if (type === "rotura_antes_electrovalvulas") return "maestra";
  if (type === "corte_corriente_plc") return "corte_corriente";
  if (type === "bateria_baja") return "corte_corriente";
  if (type === "fallo_conexion" || type === "fallo_conexion_resuelto") return "sin_datos";
  if (type === "sin_agua_red") return "sin_agua";
  if (type === "riego_excesivo") return "riego_excesivo";
  return null;
}

function debeNotificar(alarm, tecnico) {
  const categoria = categoriaDeAlarma(alarm.type);
  if (!categoria) return true;
  const prefs = tecnico?.alarmas;
  if (!prefs || prefs[categoria] === undefined) return true;
  return prefs[categoria] !== false;
}

function textoAlarma(alarm) {
  if (alarm.type === "fallo_conexion") {
    return {
      titulo: "🔌 Sin datos del sistema — todo detenido",
      descripcion: "No se está recibiendo ningún dato (ni sensores, ni caudal, ni presión) — comunicación totalmente perdida, o la batería de respaldo del PLC se ha agotado.",
      accion: "El sistema se ha apagado solo, como medida de seguridad. Se reactivará automáticamente en cuanto vuelvan a llegar datos.",
    };
  }
  if (alarm.type === "fallo_conexion_resuelto") {
    return {
      titulo: "🔌 Datos recuperados — sistema reactivado",
      descripcion: "Ha vuelto a recibirse información del sistema.",
      accion: "El sistema se ha reactivado automáticamente.",
    };
  }
  if (alarm.type === "corte_corriente_plc") {
    return {
      titulo: "⚡ Corte de corriente en el PLC — sistema apagado",
      descripcion: "El controlador de campo (Loxone) se ha quedado sin corriente eléctrica. No se puede activar ninguna electroválvula sin corriente.",
      accion:
        "El sistema se ha apagado como medida de seguridad. Gracias a la batería de respaldo, los sensores (humedad, presión, caudal) siguen llegando con normalidad mientras dure la batería. Reactiva el sistema manualmente desde el botón de arriba en cuanto vuelva la corriente.",
    };
  }
  if (alarm.type === "bateria_baja") {
    return {
      titulo: "🔋 Batería del PLC baja",
      descripcion: `La batería de respaldo del PLC está al ${alarm.value}%, por debajo del ${alarm.umbral ?? 20}% — se agotará pronto si no vuelve la corriente.`,
      accion:
        "Restablecer cuanto antes el suministro eléctrico del PLC. Cuando la batería llegue a 0%, se perderán todos los datos del panel (sensores, presión, caudal) hasta que vuelva la corriente.",
    };
  }
  if (alarm.type === "rotura_antes_electrovalvulas") {
    return {
      titulo: "⛔ Rotura antes de las electroválvulas — maestra cerrada",
      descripcion: alarm.detalle || "El caudalímetro general detecta agua que ninguna línea explica.",
      accion:
        "Requiere intervención de un técnico: localizar la rotura en la tubería general (antes del colector) y repararla. La electroválvula maestra ha sido cerrada automáticamente y no se reabrirá hasta que se rearme manualmente desde el panel.",
    };
  }
  if (alarm.type === "fuga_grave") {
    return {
      titulo: "Fuga grave (rotura)",
      descripcion: `Caudal medido de ${alarm.flowMeasured} L/h frente a ${alarm.nominalFlow} L/h esperados según los emisores instalados (≥150% del nominal).`,
      accion:
        "Revisar con urgencia la electroválvula, el ramal y los emisores de la línea indicada por probable rotura de tubería o conexión suelta. La línea ha sido aislada automáticamente por el panel y no regará hasta que se rearme manualmente tras la reparación.",
    };
  }
  if (alarm.type === "fuga_leve") {
    return {
      titulo: "Fuga leve (goteo)",
      descripcion: `Caudal medido de ${alarm.flowMeasured} L/h frente a ${alarm.nominalFlow} L/h esperados (entre 115% y 150% del nominal).`,
      accion:
        "Revisar conexiones y emisores de la línea en la próxima visita de mantenimiento. No es urgente: la línea sigue funcionando con normalidad, pero conviene comprobarla antes de que empeore.",
    };
  }
  if (alarm.type === "fallo_electrico") {
    return {
      titulo: "Fallo eléctrico de electroválvula",
      descripcion: "La línea estaba programada para regar pero el caudalímetro no ha registrado caudal alguno durante varios ciclos seguidos.",
      accion:
        "Comprobar la alimentación eléctrica de la electroválvula, el solenoide, el cableado y la conexión al programador. La línea ha sido aislada automáticamente y no volverá a intentarlo hasta que se rearme manualmente.",
    };
  }
  if (alarm.type === "fallo_electrico_resuelto") {
    return {
      titulo: "Electroválvula rearmada tras fallo eléctrico",
      descripcion: "La línea ha sido rearmada manualmente tras una incidencia de falta de respuesta de la electroválvula.",
      accion: "Confirmar que la línea vuelve a regar con normalidad en el próximo ciclo programado.",
    };
  }
  if (alarm.type === "sin_agua_red") {
    return {
      titulo: "⛔ Sin agua en la red",
      descripcion: `La presión de la red (${alarm.value} bar) lleva varios minutos por debajo de ${alarm.umbralSinAgua ?? 0.5} bar de forma continuada — no hay agua llegando, más grave que una simple presión baja.`,
      accion:
        "Comprobar urgentemente el suministro general: llave de paso cerrada, corte del suministro municipal, rotura de tubería principal o bomba de impulsión parada.",
    };
  }
  if (alarm.type === "presion_baja" || alarm.type === "presion_alta") {
    const cual =
      alarm.type === "presion_baja"
        ? `por debajo de ${alarm.umbralBaja ?? 1.0} bar`
        : `por encima de ${alarm.umbralAlta ?? 4.0} bar`;
    return {
      titulo: alarm.type === "presion_baja" ? "Presión de red sostenidamente baja" : "Presión de red sostenidamente alta",
      descripcion: `La presión de la red (${alarm.value} bar) lleva varios minutos ${cual} de forma continuada.`,
      accion:
        alarm.type === "presion_baja"
          ? "Comprobar el suministro de agua, posibles fugas en el ramal principal, filtro obstruido, o número de líneas regando simultáneamente."
          : "Comprobar el regulador de presión de cabezal; una presión excesiva y sostenida puede dañar emisores y juntas.",
    };
  }
  if (alarm.type === "embozo") {
    return {
      titulo: "Posible embozo",
      descripcion: `Caudal medido de ${alarm.flowMeasured} L/h frente a ${alarm.nominalFlow} L/h esperados (por debajo del 85% del nominal), con la presión de red en rango de trabajo.`,
      accion: "Revisar y limpiar los emisores (goteros/microaspersores) de la línea y comprobar el filtro de cabezal en la próxima visita.",
    };
  }
  if (alarm.type === "humedad_fuera_rango") {
    return {
      titulo: "Humedad de sustrato fuera de rango",
      descripcion: `Humedad medida de ${alarm.valor}% fuera del rango configurado (${alarm.min}%–${alarm.max}%) para esta línea.`,
      accion: "Comprobar el sensor de humedad y el estado del sustrato; ajustar la programación o el umbral si el rango configurado ya no es adecuado.",
    };
  }
  if (alarm.type === "ec_fuera_rango") {
    return {
      titulo: "Conductividad (CE) fuera de rango",
      descripcion: `CE medida de ${alarm.valor} mS/cm fuera del rango configurado (${alarm.min}–${alarm.max} mS/cm) para esta línea.`,
      accion: "Revisar la fertirrigación y la calidad del agua de riego de esta línea; comprobar el sensor de CE.",
    };
  }
  if (alarm.type === "temperatura_fuera_rango") {
    return {
      titulo: "Temperatura fuera de rango",
      descripcion: `Temperatura medida de ${alarm.valor}°C fuera del rango configurado (${alarm.min}°C–${alarm.max}°C) para esta línea.`,
      accion: "Comprobar riesgo de helada o estrés térmico según el caso; revisar el sensor de temperatura.",
    };
  }
  if (alarm.type === "multiples_lineas") {
    return {
      titulo: "Varias líneas con incidencias",
      descripcion: `${alarm.cantidad} líneas presentan alguna incidencia simultáneamente: ${alarm.lineas}.`,
      accion:
        "Cuando varias líneas fallan a la vez, sospechar primero de una causa común: presión de cabezal, filtro obstruido, corte de suministro o fallo del propio programador, antes de revisar cada línea por separado.",
    };
  }
  if (alarm.type === "fertilizante_bajo") {
    return {
      titulo: "Nivel de fertilizante bajo",
      descripcion: `El depósito de fertilizante está al ${alarm.value}%, por debajo del ${alarm.umbral ?? 15}% de reserva recomendado.`,
      accion: "Preparar el rellenado del depósito de fertirrigación en los próximos días para no interrumpir la dosificación.",
    };
  }
  if (alarm.type === "fertilizante_agotado") {
    return {
      titulo: "Depósito de fertilizante prácticamente agotado",
      descripcion: `El depósito de fertilizante está al ${alarm.value}%, por debajo del ${alarm.umbral ?? 5}%. El riego sigue funcionando con agua, pero sin dosificación efectiva.`,
      accion: "Rellenar el depósito de fertilizante lo antes posible para no perder el aporte nutricional programado.",
    };
  }
  if (alarm.type === "fertilizante_rellenado") {
    return {
      titulo: "Depósito de fertilizante rellenado",
      descripcion: "El depósito se ha marcado como rellenado al 100% desde el panel.",
      accion: "Ninguna acción requerida; aviso informativo de cierre de incidencia.",
    };
  }
  if (alarm.type === "riego_excesivo") {
    return {
      titulo: "💧 Riego excesivo (escorrentía)",
      descripcion: alarm.detalle || `La escorrentía marca ${alarm.value}% de humedad, por encima del umbral configurado.`,
      accion: "Revisar el tiempo/caudal de riego de las líneas de este grupo — la sonda de escorrentía indica que está saliendo agua sin aprovechar por la parte baja.",
    };
  }
  return {
    titulo: "Electroválvula rearmada",
    descripcion: "La línea ha sido rearmada manualmente y ha vuelto a funcionar con normalidad.",
    accion: "Ninguna acción requerida; aviso informativo de cierre de incidencia.",
  };
}

function construirAviso(alarm, tecnico) {
  const { titulo, descripcion, accion } = textoAlarma(alarm);
  const fecha = new Date(alarm.ts).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
  const saludo = tecnico?.nombre ? `Hola ${tecnico.nombre},` : "Hola,";
  const subject = `Verdtical Control · ${titulo} — ${alarm.lineName}`;
  const body = [
    saludo,
    "",
    `Se ha registrado una incidencia en el sistema de riego Verdtical:`,
    "",
    `Línea: ${alarm.lineName}`,
    `Tipo: ${titulo}`,
    `Fecha y hora: ${fecha}`,
    `Detalle: ${descripcion}`,
    "",
    `Acción recomendada: ${accion}`,
    "",
    "Este aviso se ha generado desde el panel de control de riego Verdtical.",
  ].join("\n");
  return { subject, body };
}

function buildMailtoUrl(alarm, tecnico) {
  const { subject, body } = construirAviso(alarm, tecnico);
  const destino = tecnico?.emailAvisos || tecnico?.email || "";
  return `mailto:${encodeURIComponent(destino)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildWhatsappUrl(alarm, tecnico) {
  const { subject, body } = construirAviso(alarm, tecnico);
  const telefono = (tecnico?.telefono || "").replace(/[^0-9]/g, "");
  const texto = `${subject}\n\n${body}`;
  return `https://wa.me/${telefono}?text=${encodeURIComponent(texto)}`;
}

function simulateSector(sector, active, hour) {
  const s = sector.sensors || { humidity: 45, temperature: 21, ec: 1.8, flowMeasured: 0 };
  const nominalFlow = Number(sector.emitters || 0) * Number(sector.emitterFlow || 0);

  // Retorno a la media: además de la variación por riego, cada sensor tira
  // suavemente hacia un valor central realista, para que no derive sin freno
  // durante sesiones largas y dispare avisos falsos.
  const HUMEDAD_OBJETIVO = 45;
  const EC_OBJETIVO = 1.8;
  const RETORNO_HUMEDAD = 0.12;
  const RETORNO_EC = 0.08;

  const humidityDelta = active ? 0.6 + Math.random() * 0.8 : -(0.15 + Math.random() * 0.25);
  const humidityConRiego = s.humidity + humidityDelta;
  const humidity = clamp(
    Math.round((humidityConRiego + (HUMEDAD_OBJETIVO - humidityConRiego) * RETORNO_HUMEDAD) * 10) / 10,
    5,
    95
  );

  const ecDelta = active ? (Math.random() - 0.3) * 0.06 : (Math.random() - 0.5) * 0.02;
  const ecConRiego = s.ec + ecDelta;
  const ec = clamp(Math.round((ecConRiego + (EC_OBJETIVO - ecConRiego) * RETORNO_EC) * 100) / 100, 0.3, 4.5);

  const baseTemp = 18 + 6 * Math.sin(((hour - 7) / 24) * 2 * Math.PI);
  const temperature = Math.round((baseTemp + (Math.random() - 0.5)) * 10) / 10;

  const flowMeasured = active ? Math.round(nominalFlow * (0.9 + Math.random() * 0.18)) : 0;

  return { humidity, ec, temperature, flowMeasured };
}

function ValveHandle({ open, size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 46 46" aria-hidden="true">
      <circle cx="23" cy="23" r="21" fill="none" stroke="var(--vc-border)" strokeWidth="2" />
      <line x1="6" y1="23" x2="40" y2="23" stroke="var(--vc-pipe)" strokeWidth="4" strokeLinecap="round" />
      <g style={{ transition: "transform 0.35s cubic-bezier(.4,0,.2,1)", transformOrigin: "23px 23px", transform: open ? "rotate(0deg)" : "rotate(90deg)" }}>
        <rect x="10" y="19" width="26" height="8" rx="4" fill="var(--vc-brass)" />
        <circle cx="23" cy="23" r="4.5" fill="var(--vc-brass-dark)" />
      </g>
    </svg>
  );
}

function StatusDot({ active, mode }) {
  const color = active ? "var(--vc-open)" : "var(--vc-red)";
  return (
    <svg width="24" height="34" viewBox="0 0 14 20" style={{ flexShrink: 0, overflow: "visible" }}>
      {/* cuerpo del magnetotérmico */}
      <rect x="1" y="1" width="12" height="18" rx="2" fill="#0a1413" stroke="var(--vc-border)" strokeWidth="1" />
      {/* marca "ON" arriba y "OFF" abajo, como en un interruptor real */}
      <line x1="4" y1="4.5" x2="10" y2="4.5" stroke="var(--vc-text-muted)" strokeWidth="0.8" />
      <line x1="4" y1="15.5" x2="10" y2="15.5" stroke="var(--vc-text-muted)" strokeWidth="0.8" />
      {/* palanca: sube (encendido) o baja (apagado) */}
      <rect
        x="3.5"
        y={active ? "2.5" : "11.5"}
        width="7"
        height="6"
        rx="1.5"
        fill={color}
        stroke="#12201f"
        strokeWidth="0.8"
        style={{ transition: "y 0.25s ease" }}
      />
    </svg>
  );
}

function Co2LeafIcon() {
  return (
    <svg width="24" height="34" viewBox="0 0 14 20" style={{ flexShrink: 0, overflow: "visible" }}>
      {/* hoja: captación de CO2 */}
      <path d="M7 2 C 12 4.5, 12.5 12, 7 18 C 1.5 12, 2 4.5, 7 2 Z" fill="#6fcf87" stroke="#1a3324" strokeWidth="1" />
      <path d="M7 4 C 7 8, 7 12, 7 16" stroke="#1a3324" strokeWidth="0.8" fill="none" />
      <path d="M7 8 L 9.5 6.5 M7 8 L 4.5 6.5 M7 12 L 9.5 10.5 M7 12 L 4.5 10.5" stroke="#1a3324" strokeWidth="0.6" fill="none" />
    </svg>
  );
}

function MiniAguaIcon({ active, danger }) {
  const color = danger ? "#e2504f" : "#4fb6c4";
  const girando = danger || active;
  return (
    <svg width="60" height="36" viewBox="0 0 26 16" style={{ flexShrink: 0, overflow: "visible" }}>
      <rect x="1" y="5" width="24" height="6" rx="3" fill="#0a1413" stroke={danger ? "#e2504f" : "#378add"} strokeWidth="1" />
      {(active || danger) && (
        <line
          x1="2.5"
          y1="8"
          x2="23.5"
          y2="8"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="3 2.5"
          className="vc-llave-flujo"
        />
      )}
      <circle cx="13" cy="8" r="4.2" fill="#0a1413" stroke={color} strokeWidth="1.2" />
      <g className={girando ? "vc-aspas-giro" : ""} style={{ transformOrigin: "13px 8px" }}>
        <line x1="13" y1="4.5" x2="13" y2="11.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
        <line x1="10" y1="5.5" x2="16" y2="10.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
        <line x1="10" y1="10.5" x2="16" y2="5.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function SensorStat({ label, value, unit, warn, wide, onClick, active, iconoAgua, lineaActiva }) {
  const clases = `vc-sensor${warn ? " vc-sensor-warn" : ""}${wide ? " vc-sensor-wide" : ""}${onClick ? " vc-sensor-clickable" : ""}${
    active ? " vc-sensor-active" : ""
  }`;
  return (
    <div className={clases} onClick={onClick} role={onClick ? "button" : undefined}>
      {iconoAgua ? <MiniAguaIcon active={lineaActiva} /> : <span className="vc-sensor-label">{label}</span>}
      <span className="vc-sensor-value">
        {value}
        <span className="vc-sensor-unit">{unit}</span>
      </span>
    </div>
  );
}

function HorarioRow({ evento, index, onChange, onRemove, canRemove, conflicto }) {
  const toggleDay = (dayKey) => {
    const days = evento.days.includes(dayKey)
      ? evento.days.filter((d) => d !== dayKey)
      : [...evento.days, dayKey];
    onChange({ ...evento, days });
  };

  return (
    <div className={conflicto ? "vc-event-block vc-event-block-conflicto" : "vc-event-block"}>
      <div className="vc-event-header">
        <span className="vc-event-title">Riego {index + 1}</span>
        {canRemove && (
          <button className="vc-event-remove" onClick={onRemove} aria-label={`Eliminar riego ${index + 1}`}>
            ×
          </button>
        )}
      </div>
      {conflicto && (
        <p className="vc-conflicto-hint">
          ⚠ se cruza con {conflicto.lineName} ({String(Math.floor(conflicto.inicio / 60)).padStart(2, "0")}:
          {String(conflicto.inicio % 60).padStart(2, "0")}–{String(Math.floor(conflicto.fin / 60)).padStart(2, "0")}:
          {String(conflicto.fin % 60).padStart(2, "0")}): el caudalímetro no distinguirá el agua de cada línea si riegan a la vez.
        </p>
      )}
      <div className="vc-day-row">
        {DIAS.map((d) => (
          <button
            key={d.key}
            className={evento.days.includes(d.key) ? "vc-day vc-day-on" : "vc-day"}
            onClick={() => toggleDay(d.key)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="vc-field-row">
        <label>
          Hora inicio
          <input type="time" value={evento.time} onChange={(e) => onChange({ ...evento, time: e.target.value })} />
        </label>
        <label>
          Duración (min)
          <input
            type="number"
            min="1"
            max="180"
            value={evento.duration}
            onChange={(e) => onChange({ ...evento, duration: Number(e.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}

function SectorCard({ sector, now, mainSupply, maestraCerrada, tecnico, cliente, presionEnRangoTrabajo, presionBaja, presionAlta, balanceHidrico, umbralBalanceHidrico, todosLosSectores, etoSol, etoSemisombra, etoSombra, factoresEstacionales, alarmHistory, alarmasInstalacion, onUpdate, onRemove, onRearm, onRearmFault, guardandoConfig, avisoGuardarConfig, onGuardarConfig }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const [combinedView, setCombinedView] = useState("hora");
  const [combinedAnnualOffset, setCombinedAnnualOffset] = useState(0);
  const [editingSeason, setEditingSeason] = useState(() => getSeasonForDate(now));
  const [avisoConflictoHorario, setAvisoConflictoHorario] = useState(null);
  const [manualMinutes, setManualMinutes] = useState(5);
  const [avisoRiegoManual, setAvisoRiegoManual] = useState(null);
  const [enviandoRiegoManual, setEnviandoRiegoManual] = useState(false);
  const [guardandoProgramacion, setGuardandoProgramacion] = useState(false);
  const [avisoGuardarProgramacion, setAvisoGuardarProgramacion] = useState(null);
  const [showRiegoLog, setShowRiegoLog] = useState(false);
  const [showLineAnnualConsumo, setShowLineAnnualConsumo] = useState(false);
  const [showHumidityAnnual, setShowHumidityAnnual] = useState(false);
  const [showHumidityYearFull, setShowHumidityYearFull] = useState(false);
  const [humidityAnnualOffset, setHumidityAnnualOffset] = useState(0);
  const [showTemperatureAnnual, setShowTemperatureAnnual] = useState(false);
  const [showTemperatureYearFull, setShowTemperatureYearFull] = useState(false);
  const [temperatureAnnualOffset, setTemperatureAnnualOffset] = useState(0);
  const [showEcAnnual, setShowEcAnnual] = useState(false);
  const [showEcYearFull, setShowEcYearFull] = useState(false);
  const [ecAnnualOffset, setEcAnnualOffset] = useState(0);
  const [showFlowAnnual, setShowFlowAnnual] = useState(false);
  const [showFlowYearFull, setShowFlowYearFull] = useState(false);
  const [flowAnnualOffset, setFlowAnnualOffset] = useState(0);
  const [selectedHourlyDay, setSelectedHourlyDay] = useState(null);
  const [horarioReal, setHorarioReal] = useState(null); // { dia, horas: number[24] } | null
  const [cargandoHorario, setCargandoHorario] = useState(false);
  const [lineAnnualOffset, setLineAnnualOffset] = useState(0);

  // El desglose por hora se pide siempre al servidor (calculado de verdad
  // desde litros_hoy) en vez de fiarse del acumulado en memoria del propio
  // navegador — antes, un día (incluido "hoy" antes de que el panel llevara
  // un rato abierto) sin el panel abierto esa hora exacta se quedaba sin
  // datos para siempre.
  useEffect(() => {
    if (!selectedHourlyDay || !sector.lineaBackendId) {
      setHorarioReal(null);
      return;
    }
    let cancelado = false;
    const diaIso =
      selectedHourlyDay === "hoy" ? null : new Date(selectedHourlyDay).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
    setCargandoHorario(true);
    obtenerHistorialHorario(sector.lineaBackendId, diaIso).then((resultado) => {
      if (cancelado) return;
      setCargandoHorario(false);
      setHorarioReal(resultado);
    });
    return () => {
      cancelado = true;
    };
  }, [selectedHourlyDay, sector.lineaBackendId]);
  const active =
    (mainSupply && !maestraCerrada && isSectorActiveNow(sector, now)) || Number(sector.sensors?.flowMeasured || 0) > 0;
  const manualActive = isManualOverrideActive(sector, now);
  const manualRemainingMs = manualActive ? new Date(sector.manualOverride.endsAt).getTime() - now.getTime() : 0;
  const nextEvent = nextEventForSector(sector, now);
  const nominalFlow = Number(sector.emitters || 0) * Number(sector.emitterFlow || 0);
  const sensors = sector.sensors || { humidity: 0, temperature: 0, ec: 0, flowMeasured: 0, litersToday: 0 };
  const th = sector.thresholds || { humidityMin: 30, humidityMax: 65, ecMin: 1.2, ecMax: 2.4 };
  const schedules = sector.schedules || {};
  const activeSeason = getSeasonForDate(now);
  const activeEventos = schedules[activeSeason] || [];
  const eventos = schedules[editingSeason] || [];
  const lineHistory = sector.history || [];

  const combinarHistoricos = (limite) => {
    const dailyLiters = sector.dailyConsumption || [];
    const dailyHum = sector.humidityDailyHistory || [];
    const dailyTemp = sector.temperatureDailyHistory || [];
    const dailyEc = sector.ecDailyHistory || [];
    const base = limite ? dailyLiters.slice(-limite) : dailyLiters;
    const fechasBase = base.map((d) => d.date);
    const filas = fechasBase.map((fecha) => {
      const l = dailyLiters.find((d) => d.date === fecha);
      const h = dailyHum.find((d) => d.date === fecha);
      const t = dailyTemp.find((d) => d.date === fecha);
      const e = dailyEc.find((d) => d.date === fecha);
      return {
        date: fecha,
        label: l ? l.label : fecha,
        liters: l ? l.liters : 0,
        humidity: h ? h.avgHumidity : null,
        temperature: t ? t.avgTemperature : null,
        ec: e ? e.avgEc : null,
      };
    });
    filas.push({
      label: "Hoy",
      liters: sensors.litersToday || 0,
      humidity: sensors.humidity,
      temperature: sensors.temperature,
      ec: sensors.ec,
    });
    return filas;
  };
  const combinedDailyData = combinarHistoricos(7);
  const combinedAnnualData = combinarHistoricos(null);
  const lineDailyChart = [...(sector.dailyConsumption || []), { label: "Hoy", liters: sensors.litersToday || 0, isToday: true }];
  const humidityChartHoraria = [
    ...(sector.humidityHourlyHistory || []),
    { label: "Ahora", humidity: sensors.humidity, isToday: true },
  ];
  const humidityChartAnual = [
    ...(sector.humidityDailyHistory || []),
    { label: "Hoy", avgHumidity: sensors.humidity, isToday: true },
  ];
  const temperatureChartHoraria = [
    ...(sector.temperatureHourlyHistory || []),
    { label: "Ahora", temperature: sensors.temperature, isToday: true },
  ];
  const temperatureChartAnual = [
    ...(sector.temperatureDailyHistory || []),
    { label: "Hoy", avgTemperature: sensors.temperature, isToday: true },
  ];
  const ecChartHoraria = [...(sector.ecHourlyHistory || []), { label: "Ahora", ec: sensors.ec, isToday: true }];
  const ecChartAnual = [...(sector.ecDailyHistory || []), { label: "Hoy", avgEc: sensors.ec, isToday: true }];
  const flowChartHoraria = [
    ...(sector.flowHourlyHistory || []),
    { label: "Ahora", flow: sensors.flowMeasured, isToday: true },
  ];
  const flowChartAnual = [
    ...(sector.flowDailyHistory || []),
    { label: "Hoy", avgFlow: sensors.flowMeasured, isToday: true },
  ];
  const hourlyChart = Array.isArray(sector.hourlyConsumption) ? sector.hourlyConsumption : Array(24).fill(0);
  const horasDelDia = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}h`);
  const hourlyHistory = sector.hourlyHistory || [];
  const esHoySeleccionado = selectedHourlyDay === "hoy";
  const diaHistoricoSeleccionado = hourlyHistory.find((d) => d.date === selectedHourlyDay);
  const diaEnDailyConsumption = (sector.dailyConsumption || []).find((d) => d.date === selectedHourlyDay);
  const diaSeleccionadoLabel = esHoySeleccionado
    ? "Hoy"
    : diaHistoricoSeleccionado?.label || diaEnDailyConsumption?.label || selectedHourlyDay;
  // Con línea conectada al backend, el desglose por hora es SIEMPRE el real
  // (horarioReal, pedido al servidor — ver el useEffect de arriba), nunca el
  // acumulado local del navegador. Sin conexión al backend (líneas de
  // demo/sin emparejar), se mantiene el cálculo antiguo en memoria.
  const hayDatosHorarios = sector.lineaBackendId
    ? !!horarioReal && Array.isArray(horarioReal.horas)
    : esHoySeleccionado || !!diaHistoricoSeleccionado;
  const horasSeleccionadas = sector.lineaBackendId
    ? horarioReal?.horas || Array(24).fill(0)
    : esHoySeleccionado
      ? hourlyChart
      : diaHistoricoSeleccionado?.hours || Array(24).fill(0);

  // alarmasInstalacion desactiva por completo un tipo de alarma para TODA
  // esta instalación (ver "Alarmas activas" en Configuración) — pensado para
  // sensores que no existen físicamente en esta instalación (p.ej. una línea
  // sin sonda de humedad), donde la alarma nunca se puede arreglar de verdad.
  const humedadActiva = alarmasInstalacion?.humedad !== false;
  const ecActiva = alarmasInstalacion?.ec !== false;
  const temperaturaActiva = alarmasInstalacion?.temperatura !== false;
  const embozoActivo = alarmasInstalacion?.embozo !== false;
  const fugasActivas = alarmasInstalacion?.fugas !== false;

  const humidityWarn = humedadActiva && (sensors.humidity < th.humidityMin || sensors.humidity > th.humidityMax);
  const ecWarn = ecActiva && (sensors.ec < th.ecMin || sensors.ec > th.ecMax);
  const temperatureWarn = temperaturaActiva && (sensors.temperature < (th.temperatureMin ?? -99) || sensors.temperature > (th.temperatureMax ?? 99));
  const presionImpideDiagnostico = active && nominalFlow > 0 && !presionEnRangoTrabajo;
  const flowMinPct = (th.flowMinPercent ?? 85) / 100;
  const flowMaxPct = (th.flowMaxPercent ?? 115) / 100;
  // No se compara el caudal instantáneo aquí: nada más abrir la válvula el
  // caudal real todavía puede marcar 0 (el dato tarda en llegar), y eso
  // encendía "posible embozo" de inmediato. En su lugar se usa sector.clogFlag,
  // que solo se activa tras mantenerse bajo durante las horas sostenidas
  // configuradas (ver embozoHorasSostenidas más abajo).
  const clogWarn = embozoActivo && !presionImpideDiagnostico && active && nominalFlow > 0 && !!sector.clogFlag;
  const leakLeveWarn =
    fugasActivas &&
    !presionImpideDiagnostico &&
    active &&
    nominalFlow > 0 &&
    sensors.flowMeasured >= nominalFlow * flowMaxPct &&
    sensors.flowMeasured < nominalFlow * 1.5;
  const leakGraveWarn = fugasActivas && !presionImpideDiagnostico && active && nominalFlow > 0 && sensors.flowMeasured >= nominalFlow * 1.5;
  const flowOk = !presionImpideDiagnostico && active && nominalFlow > 0 && !clogWarn && !leakLeveWarn && !leakGraveWarn;
  const flowWarn = clogWarn || leakLeveWarn || leakGraveWarn;

  const updateEvento = (idx, updated) => {
    const nuevos = eventos.map((ev, i) => (i === idx ? updated : ev));
    onUpdate({ ...sector, schedules: { ...schedules, [editingSeason]: nuevos } });
  };

  const removeEvento = (idx) => {
    onUpdate({ ...sector, schedules: { ...schedules, [editingSeason]: eventos.filter((_, i) => i !== idx) } });
  };

  const addEvento = () => {
    if (eventos.length >= MAX_HORARIOS_POR_LINEA) return;
    const last = eventos[eventos.length - 1];
    let horaNueva = "06:00";
    if (last) {
      const [h, m] = last.time.split(":").map(Number);
      const siguienteHora = (h + 1) % 24;
      horaNueva = `${String(siguienteHora).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    const nuevos = [...eventos, nuevoHorario(last ? { time: horaNueva, days: [...last.days] } : {})];
    onUpdate({ ...sector, schedules: { ...schedules, [editingSeason]: nuevos } });
  };

  // Guarda de golpe todos los eventos de la temporada que se está editando
  // como programación real (backend) para esta línea — a partir de ahí es
  // lo que el riego automático ejecutará de verdad, sin necesitar el panel
  // abierto. Reemplaza toda la temporada (no un diff evento a evento, ver
  // guardarProgramacionTemporada en apiClient.js).
  const guardarProgramacion = async () => {
    if (!sector.lineaBackendId) return;
    setAvisoGuardarProgramacion(null);
    setGuardandoProgramacion(true);
    const resultado = await guardarProgramacionTemporada(
      sector.lineaBackendId,
      editingSeason,
      eventos.map((ev) => ({
        dias_semana: diasKeyADiasSemana(ev.days),
        hora_inicio: ev.time,
        duracion_minutos: Number(ev.duration || 0),
      }))
    );
    setGuardandoProgramacion(false);
    if (!resultado.ok) {
      setAvisoGuardarProgramacion(`No se pudo guardar: ${resultado.error}`);
      return;
    }
    const eventosGuardados = resultado.eventos.map(mapProgramaFromApi);
    onUpdate({
      ...sector,
      schedules: { ...schedules, [editingSeason]: eventosGuardados },
      schedulesGuardadas: { ...(sector.schedulesGuardadas || {}), [editingSeason]: true },
    });
  };

  // Si el sector ya tiene línea real emparejada con el backend (Loxone
  // conectado), se espera la respuesta real antes de actualizar la pantalla
  // — nunca optimista, esto abre/cierra una electroválvula de verdad. Si
  // no hay línea emparejada (instalación aún sin Loxone conectado), se
  // mantiene el comportamiento 100% local de siempre, sin cambios.
  const iniciarRiegoManual = async () => {
    const minutos = Math.max(1, Math.min(180, Number(manualMinutes) || 1));
    if (!sector.lineaBackendId) {
      const endsAt = new Date(now.getTime() + minutos * 60000).toISOString();
      onUpdate({ ...sector, manualOverride: { active: true, endsAt, minutes: minutos } });
      return;
    }
    setAvisoRiegoManual(null);
    setEnviandoRiegoManual(true);
    const resultado = await abrirRiegoManual(sector.lineaBackendId);
    setEnviandoRiegoManual(false);
    if (!resultado.ok) {
      setAvisoRiegoManual(`No se pudo abrir el riego: ${resultado.error}`);
      return;
    }
    const endsAt = new Date(now.getTime() + minutos * 60000).toISOString();
    onUpdate({ ...sector, manualOverride: { active: true, endsAt, minutes: minutos } });
  };

  const detenerRiegoManual = async () => {
    if (!sector.lineaBackendId) {
      onUpdate({ ...sector, manualOverride: null });
      return;
    }
    setAvisoRiegoManual(null);
    setEnviandoRiegoManual(true);
    const resultado = await cerrarRiegoManual(sector.lineaBackendId);
    setEnviandoRiegoManual(false);
    if (!resultado.ok) {
      setAvisoRiegoManual(`No se pudo cerrar el riego: ${resultado.error}`);
      return;
    }
    onUpdate({ ...sector, manualOverride: null });
  };

  return (
    <div
      className={[
        "vc-card",
        sector.blockedByLeak ? "vc-card-leak" : "",
        editingSchedule ? "vc-card-wide" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        zIndex:
          editingSchedule ||
          showCharts ||
          showRiegoLog ||
          showLineAnnualConsumo ||
          showHumidityAnnual ||
          showTemperatureAnnual ||
          showEcAnnual ||
          showFlowAnnual
            ? 5
            : 1,
        gridColumn:
          showCharts ||
          showRiegoLog ||
          showLineAnnualConsumo ||
          showHumidityAnnual ||
          showTemperatureAnnual ||
          showEcAnnual ||
          showFlowAnnual
            ? "span 2"
            : undefined,
      }}
    >
      <div className="vc-card-top">
        <div className="vc-card-title">
          <input
            className="vc-name-input"
            value={sector.name}
            onChange={(e) => onUpdate({ ...sector, name: e.target.value })}
            aria-label="Nombre de la línea"
          />
        </div>
        <button className="vc-icon-btn" onClick={() => setConfirmDelete(true)} aria-label="Eliminar línea" title="Eliminar línea">
          ×
        </button>
      </div>

      {confirmDelete && (
        <div className="vc-confirm-delete">
          <span>¿Eliminar {sector.name}? Se perderá su historial de riegos y consumo.</span>
          <div className="vc-confirm-delete-actions">
            <button className="vc-confirm-cancel" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </button>
            <button className="vc-confirm-yes" onClick={onRemove}>
              Sí, eliminar
            </button>
          </div>
        </div>
      )}

      <div className="vc-card-body">
        <ValveHandle open={active} />
        <div className="vc-readout">
          <span className="vc-readout-label">{active ? "abierta" : "cerrada"}</span>
          <span className="vc-readout-value">{nominalFlow} L/h nom.</span>
        </div>
      </div>

      <div className="vc-sensor-grid">
        <SensorStat
          label="Humedad"
          value={sensors.humidity}
          unit="%"
          warn={humidityWarn}
          onClick={() => setShowHumidityAnnual((v) => !v)}
          active={showHumidityAnnual}
        />
        <SensorStat
          label="Temp."
          value={sensors.temperature}
          unit="°C"
          warn={temperatureWarn}
          onClick={() => setShowTemperatureAnnual((v) => !v)}
          active={showTemperatureAnnual}
        />
        <SensorStat
          label="CE"
          value={sensors.ec}
          unit="mS/cm"
          warn={ecWarn}
          onClick={() => setShowEcAnnual((v) => !v)}
          active={showEcAnnual}
        />
        <SensorStat
          label="Caudalím."
          value={sensors.flowMeasured}
          unit="L/h"
          warn={flowWarn}
          onClick={() => setShowFlowAnnual((v) => !v)}
          active={showFlowAnnual}
        />
        <SensorStat
          value={sensors.litersToday || 0}
          unit="L"
          warn={false}
          wide
          iconoAgua
          lineaActiva={active}
          onClick={() => setShowLineAnnualConsumo((v) => !v)}
          active={showLineAnnualConsumo}
        />
      </div>
      {showHumidityAnnual && (
        <div className="vc-annual-chart-wrap">
          <div className="vc-hourly-detail-title">
            <span>Humedad — lecturas reales por hora ({humidityChartHoraria.length} lecturas, últimos 7 días)</span>
            <button className="vc-cal-dia-cerrar-btn" onClick={() => setShowHumidityAnnual(false)}>
              ✕
            </button>
          </div>
          <TrendChart
            data={humidityChartHoraria}
            color="var(--vc-flow)"
            unit="%"
            dataKey="humidity"
            height={200}
            umbralMin={th.humidityMin}
            umbralMax={th.humidityMax}
          />
          <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setShowHumidityYearFull((v) => !v)}>
            {showHumidityYearFull
              ? "ocultar historial de 1 año"
              : `ver historial de 1 año (${humidityChartAnual.length} días, media diaria)`}
          </button>
          {showHumidityYearFull && (
            <div className="vc-annual-chart-wrap">
              <TrendChart
                data={ventanaDatos(humidityChartAnual, humidityAnnualOffset, VENTANA_DIAS_HISTORICO)}
                color="var(--vc-violet)"
                unit="%"
                dataKey="avgHumidity"
                height={200}
                umbralMin={th.humidityMin}
                umbralMax={th.humidityMax}
              />
              <ChartNavBar
                offset={humidityAnnualOffset}
                setOffset={setHumidityAnnualOffset}
                total={humidityChartAnual.length}
                windowSize={VENTANA_DIAS_HISTORICO}
              />
            </div>
          )}
        </div>
      )}
      {showTemperatureAnnual && (
        <div className="vc-annual-chart-wrap">
          <div className="vc-hourly-detail-title">
            <span>Temperatura — lecturas reales por hora ({temperatureChartHoraria.length} lecturas, últimos 7 días)</span>
            <button className="vc-cal-dia-cerrar-btn" onClick={() => setShowTemperatureAnnual(false)}>
              ✕
            </button>
          </div>
          <TrendChart
            data={temperatureChartHoraria}
            color="var(--vc-heat)"
            unit="°C"
            dataKey="temperature"
            height={200}
            umbralMin={th.temperatureMin}
            umbralMax={th.temperatureMax}
          />
          <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setShowTemperatureYearFull((v) => !v)}>
            {showTemperatureYearFull
              ? "ocultar historial de 1 año"
              : `ver historial de 1 año (${temperatureChartAnual.length} días, media diaria)`}
          </button>
          {showTemperatureYearFull && (
            <div className="vc-annual-chart-wrap">
              <TrendChart
                data={ventanaDatos(temperatureChartAnual, temperatureAnnualOffset, VENTANA_DIAS_HISTORICO)}
                color="var(--vc-violet)"
                unit="°C"
                dataKey="avgTemperature"
                height={200}
                umbralMin={th.temperatureMin}
                umbralMax={th.temperatureMax}
              />
              <ChartNavBar
                offset={temperatureAnnualOffset}
                setOffset={setTemperatureAnnualOffset}
                total={temperatureChartAnual.length}
                windowSize={VENTANA_DIAS_HISTORICO}
              />
            </div>
          )}
        </div>
      )}
      {showEcAnnual && (
        <div className="vc-annual-chart-wrap">
          <div className="vc-hourly-detail-title">
            <span>CE — lecturas reales por hora ({ecChartHoraria.length} lecturas, últimos 7 días)</span>
            <button className="vc-cal-dia-cerrar-btn" onClick={() => setShowEcAnnual(false)}>
              ✕
            </button>
          </div>
          <TrendChart
            data={ecChartHoraria}
            color="var(--vc-violet)"
            unit="mS/cm"
            dataKey="ec"
            height={200}
            umbralMin={th.ecMin}
            umbralMax={th.ecMax}
          />
          <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setShowEcYearFull((v) => !v)}>
            {showEcYearFull ? "ocultar historial de 1 año" : `ver historial de 1 año (${ecChartAnual.length} días, media diaria)`}
          </button>
          {showEcYearFull && (
            <div className="vc-annual-chart-wrap">
              <TrendChart
                data={ventanaDatos(ecChartAnual, ecAnnualOffset, VENTANA_DIAS_HISTORICO)}
                color="var(--vc-brass)"
                unit="mS/cm"
                dataKey="avgEc"
                height={200}
                umbralMin={th.ecMin}
                umbralMax={th.ecMax}
              />
              <ChartNavBar offset={ecAnnualOffset} setOffset={setEcAnnualOffset} total={ecChartAnual.length} windowSize={VENTANA_DIAS_HISTORICO} />
            </div>
          )}
        </div>
      )}
      {showFlowAnnual && (
        <div className="vc-annual-chart-wrap">
          <div className="vc-hourly-detail-title">
            <span>Caudalímetro — lecturas reales por hora ({flowChartHoraria.length} lecturas, últimos 7 días)</span>
            <button className="vc-cal-dia-cerrar-btn" onClick={() => setShowFlowAnnual(false)}>
              ✕
            </button>
          </div>
          <TrendChart
            data={flowChartHoraria}
            color="var(--vc-flow)"
            unit="L/h"
            dataKey="flow"
            height={200}
            umbralMin={nominalFlow > 0 ? Math.round(nominalFlow * ((th.flowMinPercent ?? 85) / 100)) : undefined}
            umbralMax={nominalFlow > 0 ? Math.round(nominalFlow * ((th.flowMaxPercent ?? 115) / 100)) : undefined}
          />
          <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setShowFlowYearFull((v) => !v)}>
            {showFlowYearFull ? "ocultar historial de 1 año" : `ver historial de 1 año (${flowChartAnual.length} días, media diaria)`}
          </button>
          {showFlowYearFull && (
            <div className="vc-annual-chart-wrap">
              <TrendChart
                data={ventanaDatos(flowChartAnual, flowAnnualOffset, VENTANA_DIAS_HISTORICO)}
                color="var(--vc-brass)"
                unit="L/h"
                dataKey="avgFlow"
                height={200}
                umbralMin={nominalFlow > 0 ? Math.round(nominalFlow * ((th.flowMinPercent ?? 85) / 100)) : undefined}
                umbralMax={nominalFlow > 0 ? Math.round(nominalFlow * ((th.flowMaxPercent ?? 115) / 100)) : undefined}
              />
              <ChartNavBar
                offset={flowAnnualOffset}
                setOffset={setFlowAnnualOffset}
                total={flowChartAnual.length}
                windowSize={VENTANA_DIAS_HISTORICO}
              />
            </div>
          )}
          {presionImpideDiagnostico && (
            <p className="vc-thresholds-note">
              ⚠ Presión de red fuera de rango ahora mismo: los umbrales de caudal no se están evaluando para esta línea hasta que la
              presión vuelva a {presionBaja}–{presionAlta} bar.
            </p>
          )}
          <div className="vc-outage-log">
            <div className="vc-outage-log-title">Alarmas de caudal registradas — {(sector.flowAlarmLog || []).length}</div>
            {(sector.flowAlarmLog || []).length === 0 ? (
              <div className="vc-chart-empty">sin alarmas de sobre-caudal ni embozo registradas</div>
            ) : (
              (sector.flowAlarmLog || []).slice(0, 30).map((a, i) => {
                const etiqueta =
                  a.tipo === "embozo" ? "Embozo (caudal bajo)" : a.tipo === "fuga_leve" ? "Sobre-caudal leve" : "Sobre-caudal grave";
                const claseColor = a.tipo === "fuga_grave" ? "vc-flow-alarm-item-grave" : "vc-flow-alarm-item-leve";
                return (
                  <div className={"vc-outage-log-item " + claseColor} key={i}>
                    <span>
                      {etiqueta} · {new Date(a.ts).toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short" })} ·{" "}
                      {new Date(a.ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span>
                      {a.flowMeasured} L/h ({a.porcentaje}% del nominal)
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
      {showLineAnnualConsumo && (
        <div className="vc-annual-chart-wrap">
          <div className="vc-hourly-detail-title">
            <span>
              Consumo diario — historial de 1 año ({(sector.dailyConsumption || []).length} días) — pulsa un día para ver sus horas
            </span>
            <button className="vc-cal-dia-cerrar-btn" onClick={() => setShowLineAnnualConsumo(false)}>
              ✕
            </button>
          </div>
          <DailyBarChart
            data={ventanaDatos(lineDailyChart, lineAnnualOffset, VENTANA_DIAS_HISTORICO)}
            color="var(--vc-brass)"
            unit="L"
            height={220}
            onBarClick={(entry) => setSelectedHourlyDay(entry.date || "hoy")}
          />
          <ChartNavBar
            offset={lineAnnualOffset}
            setOffset={setLineAnnualOffset}
            total={lineDailyChart.length}
            windowSize={VENTANA_DIAS_HISTORICO}
          />
          {selectedHourlyDay && (
            <div className="vc-hourly-detail">
              <div className="vc-hourly-detail-title">
                <span>Consumo por hora — {diaSeleccionadoLabel}</span>
                <button className="vc-cal-dia-cerrar-btn" onClick={() => setSelectedHourlyDay(null)}>
                  ✕
                </button>
              </div>
              {sector.lineaBackendId && cargandoHorario ? (
                <div className="vc-chart-empty">Cargando…</div>
              ) : hayDatosHorarios ? (
                <DailyBarChart
                  data={horasDelDia.map((h, i) => ({
                    label: h,
                    liters: horasSeleccionadas[i],
                    isToday: esHoySeleccionado && i === new Date().getHours(),
                  }))}
                  color="var(--vc-flow)"
                  unit="L"
                  height={160}
                  todayColor="var(--vc-brass)"
                />
              ) : (
                <div className="vc-chart-empty">
                  {sector.lineaBackendId
                    ? "Todavía no hay lecturas guardadas para este día."
                    : "No hay detalle por hora guardado para este día (solo se conservan los últimos 14 días)."}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {presionImpideDiagnostico && (
        <div className="vc-alert-line vc-alert-pressure-first">
          ⚠ presión de red fuera de {presionBaja}–{presionAlta} bar: comprobar la presión antes de diagnosticar embozo o fuga en esta línea (el caudal medido
          no es fiable con esta presión)
        </div>
      )}
      {balanceHidrico &&
        balanceHidrico.hayDatos &&
        Math.abs(balanceHidrico.diferenciaPct) >= (umbralBalanceHidrico ?? 30) &&
        balanceHidrico.necesidadTeorica > 0 && (
          <div className={"vc-alert-line " + (balanceHidrico.diferenciaLinea >= 0 ? "vc-alert-escorrentia" : "vc-alert-deficit")}>
            ⚠ {balanceHidrico.diferenciaLinea >= 0 ? "posible escorrentía" : "posible déficit de riego"} AYER: se regaron{" "}
            {balanceHidrico.consumoRealLinea} L frente a {balanceHidrico.necesidadTeorica} L necesarios (
            {balanceHidrico.diferenciaLinea >= 0 ? "+" : ""}
            {balanceHidrico.diferenciaPct}%)
          </div>
        )}
      {(humidityWarn || ecWarn || temperatureWarn || flowWarn) && (
        <div className="vc-alert-line">
          ⚠ {humidityWarn ? "humedad fuera de rango · " : ""}
          {temperatureWarn ? "temperatura fuera de rango · " : ""}
          {ecWarn ? "CE fuera de rango · " : ""}
          {clogWarn ? "posible embozo: caudal por debajo de lo requerido por los emisores" : ""}
          {leakLeveWarn ? "posible goteo (fuga leve): caudal algo por encima de lo esperado" : ""}
          {leakGraveWarn ? "fuga grave: caudal muy por encima de lo esperado" : ""}
        </div>
      )}
      {flowOk && !humidityWarn && !ecWarn && !temperatureWarn && <div className="vc-alert-line vc-alert-ok">✓ caudal correcto</div>}

      {sector.blockedByLeak && (
        <div className="vc-blocked-banner">
          <span>
            ⚠ Fuga grave detectada ({sensors.flowMeasured} L/h frente a {nominalFlow} L/h esperados) — electroválvula aislada
            automáticamente.
          </span>
          <div className="vc-leak-actions">
            {tecnico.alarmas?.fugas !== false && (
              <>
                <a
                  className="vc-alarm-notify-link"
                  href={buildMailtoUrl(
                    { lineId: sector.id, lineName: sector.name, ts: now.toISOString(), flowMeasured: sensors.flowMeasured, nominalFlow, type: "fuga_grave" },
                    tecnico
                  )}
                >
                  ✉ avisar técnico
                </a>
                {tecnico.telefono && (
                  <a
                    className="vc-alarm-notify-link"
                    href={buildWhatsappUrl(
                      { lineId: sector.id, lineName: sector.name, ts: now.toISOString(), flowMeasured: sensors.flowMeasured, nominalFlow, type: "fuga_grave" },
                      tecnico
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    💬 WhatsApp
                  </a>
                )}
              </>
            )}
            {cliente?.alarmas?.fugas === true && cliente.email && (
              <a
                className="vc-alarm-notify-link vc-alarm-notify-link-cliente"
                href={buildMailtoUrl(
                  { lineId: sector.id, lineName: sector.name, ts: now.toISOString(), flowMeasured: sensors.flowMeasured, nominalFlow, type: "fuga_grave" },
                  cliente
                )}
              >
                ✉ avisar cliente
              </a>
            )}
            <button className="vc-leak-rearm vc-leak-rearm-sm" onClick={() => onRearm(sector.id, sector.name)}>
              Rearmar
            </button>
          </div>
        </div>
      )}

      {sector.blockedByFault && (
        <div className="vc-blocked-banner vc-blocked-banner-fault">
          <span>⚠ posible fallo eléctrico: no responde</span>
          <div className="vc-leak-actions">
            {tecnico.alarmas?.fallo_electrico !== false && (
              <a
                className="vc-alarm-notify-link"
                href={buildMailtoUrl(
                  { lineId: sector.id, lineName: sector.name, ts: now.toISOString(), type: "fallo_electrico" },
                  tecnico
                )}
              >
                ✉ avisar técnico
              </a>
            )}
            {cliente?.alarmas?.fallo_electrico === true && cliente.email && (
              <a
                className="vc-alarm-notify-link vc-alarm-notify-link-cliente"
                href={buildMailtoUrl(
                  { lineId: sector.id, lineName: sector.name, ts: now.toISOString(), type: "fallo_electrico" },
                  cliente
                )}
              >
                ✉ avisar cliente
              </a>
            )}
            <button className="vc-leak-rearm vc-leak-rearm-sm" onClick={() => onRearmFault(sector.id, sector.name)}>
              Rearmar
            </button>
          </div>
        </div>
      )}

      <div className="vc-toggle-row">
        <button className="vc-toggle-btn" onClick={() => setShowCharts((v) => !v)}>
          {showCharts ? "ocultar gráficas en grupo" : "ver gráficas en grupo"}
        </button>
        <button className="vc-toggle-btn" onClick={() => setShowRiegoLog((v) => !v)}>
          {showRiegoLog ? "ocultar historial" : `ver historial de riegos (${(sector.riegoLog || []).length})`}
        </button>
      </div>

      {showCharts && (
        <div className="vc-combined-chart-wrap">
          <div className="vc-mini-chart-title">
            <span>
              Gráficas en grupo (humedad, temperatura, CE y agua) —{" "}
              {combinedView === "hora"
                ? "últimos ~30 min"
                : combinedView === "dia"
                ? "última semana (media diaria)"
                : `historial de 1 año (${combinedAnnualData.length} días, media diaria)`}
            </span>
          </div>
          <div className="vc-day-tabs">
            <button
              className={combinedView === "hora" ? "vc-day-tab vc-day-tab-on" : "vc-day-tab"}
              onClick={() => setCombinedView("hora")}
            >
              por hora
            </button>
            <button
              className={combinedView === "dia" ? "vc-day-tab vc-day-tab-on" : "vc-day-tab"}
              onClick={() => setCombinedView("dia")}
            >
              por día (7 días)
            </button>
            <button
              className={combinedView === "año" ? "vc-day-tab vc-day-tab-on" : "vc-day-tab"}
              onClick={() => setCombinedView("año")}
            >
              por año
            </button>
          </div>
          {combinedView === "hora" ? (
            lineHistory.length > 1 ? (
              <CombinedLineChart data={lineHistory} height={240} />
            ) : (
              <div className="vc-chart-empty vc-chart-empty-sm">registrando…</div>
            )
          ) : combinedView === "dia" ? (
            combinedDailyData.length > 1 ? (
              <CombinedLineChart data={combinedDailyData} height={240} />
            ) : (
              <div className="vc-chart-empty vc-chart-empty-sm">todavía no hay una semana de datos guardados</div>
            )
          ) : combinedAnnualData.length > 1 ? (
            <>
              <CombinedLineChart data={ventanaDatos(combinedAnnualData, combinedAnnualOffset, VENTANA_DIAS_HISTORICO)} height={240} />
              <ChartNavBar
                offset={combinedAnnualOffset}
                setOffset={setCombinedAnnualOffset}
                total={combinedAnnualData.length}
                windowSize={VENTANA_DIAS_HISTORICO}
              />
            </>
          ) : (
            <div className="vc-chart-empty vc-chart-empty-sm">todavía no hay suficiente histórico guardado</div>
          )}
        </div>
      )}

      {showRiegoLog && (
        <div className="vc-riego-log">
          {(sector.riegoLog || []).length === 0 ? (
            <div className="vc-history-empty">todavía no hay riegos registrados en esta línea</div>
          ) : (
            (sector.riegoLog || []).map((r) => (
              <div className="vc-riego-log-item" key={r.id}>
                <span className={`vc-riego-tag vc-riego-tag-${r.tipo}`}>{r.tipo}</span>
                <span className="vc-riego-log-time">
                  {new Date(r.startTs).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  {" – "}
                  {new Date(r.endTs).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="vc-riego-log-stats">
                  {r.durationMin} min · {r.liters} L
                </span>
              </div>
            ))
          )}
          <div className="vc-history-title vc-history-title-sub">
            Historial de fugas en esta línea ({(alarmHistory || []).filter((a) => a.lineId === sector.id && (a.type === "fuga_grave" || a.type === "fuga_rearmada")).length})
          </div>
          {(alarmHistory || []).filter((a) => a.lineId === sector.id && (a.type === "fuga_grave" || a.type === "fuga_rearmada")).length === 0 ? (
            <div className="vc-history-empty">sin fugas registradas todavía en esta línea</div>
          ) : (
            (alarmHistory || [])
              .filter((a) => a.lineId === sector.id && (a.type === "fuga_grave" || a.type === "fuga_rearmada"))
              .map((a) => (
                <div className="vc-riego-log-item" key={a.id}>
                  <span className={a.type === "fuga_rearmada" ? "vc-riego-tag vc-riego-tag-fuga-ok" : "vc-riego-tag vc-riego-tag-fuga"}>
                    {a.type === "fuga_rearmada" ? "✓ rearmada" : "⚠ fuga"}
                  </span>
                  <span className="vc-riego-log-time">
                    {new Date(a.ts).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {a.flowMeasured !== undefined && (
                    <span className="vc-riego-log-stats">
                      {a.flowMeasured} L/h (esperado {a.nominalFlow} L/h)
                    </span>
                  )}
                </div>
              ))
          )}
        </div>
      )}

      <div className="vc-mode-toggle">
        <button
          className={sector.mode === "horario" ? "vc-mode-btn vc-mode-btn-on" : "vc-mode-btn"}
          onClick={() => onUpdate({ ...sector, mode: "horario" })}
        >
          Horario
        </button>
        <button
          className={sector.mode === "sensor" ? "vc-mode-btn vc-mode-btn-on" : "vc-mode-btn"}
          onClick={() => onUpdate({ ...sector, mode: "sensor" })}
        >
          Riego con sensor
        </button>
        <button
          className={sector.mode === "apagado" ? "vc-mode-btn vc-mode-btn-on" : "vc-mode-btn"}
          onClick={() => onUpdate({ ...sector, mode: "apagado" })}
        >
          Apagado
        </button>
      </div>

      <div className="vc-manual-block">
        {manualActive ? (
          <>
            <span className="vc-manual-countdown">
              riego manual en curso · quedan {Math.max(0, Math.ceil(manualRemainingMs / 60000))} min
            </span>
            <button className="vc-manual-stop" onClick={detenerRiegoManual} disabled={enviandoRiegoManual}>
              {enviandoRiegoManual ? "cerrando…" : "Detener"}
            </button>
          </>
        ) : (
          <>
            <input
              type="number"
              min="1"
              max="180"
              className="vc-manual-input"
              value={manualMinutes}
              onChange={(e) => setManualMinutes(e.target.value)}
              aria-label="Minutos de riego manual"
            />
            <span className="vc-manual-unit">min</span>
            <button
              className="vc-manual-start"
              onClick={iniciarRiegoManual}
              disabled={sector.blockedByLeak || enviandoRiegoManual}
            >
              {enviandoRiegoManual ? "abriendo…" : "Riego manual"}
            </button>
          </>
        )}
      </div>
      {avisoRiegoManual && (
        <p className="vc-tecnico-hint" style={{ color: "var(--vc-red)", margin: "4px 0 0" }}>{avisoRiegoManual}</p>
      )}

      {sector.mode === "sensor" && (
        <div className="vc-sensor-hint">
          humedad {sensors.humidity}% · mínimo {th.humidityMin}% →{" "}
          {sensors.humidity < th.humidityMin ? "regará en el próximo horario" : "dentro de rango, no riega"}
        </div>
      )}

      {sector.mode === "apagado" && !manualActive ? (
        <div className="vc-next-event">línea apagada — no regará por horario hasta que cambies el modo</div>
      ) : sector.mode === "apagado" ? null : (
        <div className="vc-next-event">
          próximo riego: <strong>{formatEventDate(nextEvent, now)}</strong>
          <span className="vc-event-count">
            {" "}
            · {activeEventos.length} horario{activeEventos.length !== 1 ? "s" : ""} · {ESTACIONES.find((e) => e.key === activeSeason)?.label}
          </span>
        </div>
      )}

      <div className="vc-exposicion-fila">
        <span className="vc-exposicion-label">exposición:</span>
        <select
          value={sector.exposicion || "sol"}
          onChange={(e) => onUpdate({ ...sector, exposicion: e.target.value })}
          className="vc-plano-input-sm"
        >
          <option value="sol">☀ sol</option>
          <option value="semisombra">⛅ semisombra</option>
          <option value="sombra">☁ sombra</option>
        </select>
      </div>

      <button className="vc-link-btn" onClick={() => setEditingSchedule((v) => !v)}>
        {editingSchedule ? "ocultar horarios y umbrales" : "editar horarios y umbrales"}
      </button>

      {editingSchedule && (
        <div className="vc-schedule-editor">
          {sector.areaM2 > 0 && (
            <div className="vc-auto-programa">
              <label className="vc-auto-duracion-label">
                Duración de cada tanda (min)
                <input
                  type="number"
                  min="1"
                  value={sector.duracionTandaAuto ?? 25}
                  onChange={(e) => onUpdate({ ...sector, duracionTandaAuto: Math.max(1, Number(e.target.value) || 1) })}
                  className="vc-plano-input-sm"
                  onClick={(e) => e.stopPropagation()}
                />
              </label>
              <button
                className="vc-cliente-copiar-btn"
                onClick={() => {
                  const etoLinea = { sol: etoSol ?? 7, semisombra: etoSemisombra ?? 4.75, sombra: etoSombra ?? 2.5 }[sector.exposicion] ?? (etoSol ?? 7);
                  const ocupacionPorEstacion = {};
                  ESTACIONES.forEach((est) => {
                    ocupacionPorEstacion[est.key] = obtenerOcupacion(todosLosSectores, sector.id, est.key);
                  });
                  const { schedules: nuevosSchedules, resumenPorEstacion } = calcularProgramacionAutomaticaTodasEstaciones({
                    areaM2: sector.areaM2,
                    etoBase: etoLinea,
                    nominalFlow,
                    duracionSesion: sector.duracionTandaAuto ?? 25,
                    ocupacionPorEstacion,
                    factoresEstacionales,
                  });
                  onUpdate({ ...sector, schedules: nuevosSchedules });
                  const conflictosTotales = Object.values(resumenPorEstacion).reduce((sum, r) => sum + r.conflictosSinResolver, 0);
                  if (conflictosTotales > 0) {
                    setAvisoConflictoHorario(
                      `⚠ ${conflictosTotales} tanda(s), repartidas entre las 4 estaciones, no encontraron hueco libre del todo — revísalas a mano.`
                    );
                  } else {
                    setAvisoConflictoHorario(null);
                  }
                }}
              >
                🔄 calcular programación automática (las 4 estaciones)
              </button>
              <p className="vc-tecnico-hint" style={{ margin: "4px 0 0" }}>
                Con {sector.areaM2} m² y exposición "{sector.exposicion || "sol"}", calcula, PARA CADA ESTACIÓN por separado,
                cuántas tandas de {sector.duracionTandaAuto ?? 25} min hacen falta para completar el agua que toca ese trimestre —
                el tamaño de tanda se mantiene siempre igual, lo que cambia es cuántas veces se repite (menos en invierno, más en
                verano), evitando coincidir con las demás líneas en cada estación por separado. Cambia el número de ahí arriba y
                vuelve a pulsar para recalcular con otro tamaño de tanda.
              </p>
              {avisoConflictoHorario && <p className="vc-tecnico-hint" style={{ color: "var(--vc-red)", margin: "4px 0 0" }}>{avisoConflictoHorario}</p>}
            </div>
          )}
          <div className="vc-season-tabs">
            {ESTACIONES.map((est) => (
              <button
                key={est.key}
                className={editingSeason === est.key ? "vc-season-tab vc-season-tab-on" : "vc-season-tab"}
                onClick={() => setEditingSeason(est.key)}
              >
                {est.label}
                {activeSeason === est.key && <span className="vc-season-dot" title="Estación en curso" />}
              </button>
            ))}
          </div>
          {(() => {
            const ocupacionEstacion = obtenerOcupacion(todosLosSectores, sector.id, editingSeason);
            return eventos.map((ev, idx) => {
              const conflicto = buscarConflicto(ev.days, horaAMinutos(ev.time), Number(ev.duration || 0), ocupacionEstacion);
              return (
                <HorarioRow
                  key={ev.id}
                  evento={ev}
                  index={idx}
                  onChange={(updated) => updateEvento(idx, updated)}
                  onRemove={() => removeEvento(idx)}
                  canRemove={eventos.length > 1}
                  conflicto={conflicto}
                />
              );
            });
          })()}
          <button className="vc-add-event-btn" onClick={addEvento} disabled={eventos.length >= MAX_HORARIOS_POR_LINEA}>
            + añadir horario ({eventos.length}/{MAX_HORARIOS_POR_LINEA})
          </button>

          {sector.lineaBackendId && (
            <div className="vc-manual-block" style={{ marginTop: "6px" }}>
              <button className="vc-manual-start" onClick={guardarProgramacion} disabled={guardandoProgramacion}>
                {guardandoProgramacion ? "guardando…" : "Guardar programación"}
              </button>
              <span
                className="vc-tecnico-hint"
                style={{ margin: 0, color: sector.schedulesGuardadas?.[editingSeason] ? "var(--vc-flow)" : "var(--vc-amber)" }}
              >
                {sector.schedulesGuardadas?.[editingSeason]
                  ? "✓ guardada — el riego automático la ejecuta de verdad"
                  : "⚠ sin guardar — de momento solo local, el riego automático no la ve"}
              </span>
            </div>
          )}
          {avisoGuardarProgramacion && (
            <p className="vc-tecnico-hint" style={{ color: "var(--vc-red)", margin: "4px 0 0" }}>{avisoGuardarProgramacion}</p>
          )}

          <div className="vc-threshold-title">Umbrales de sensores</div>
          <div className="vc-field-row">
            <label>
              Emisores
              <input
                type="number"
                min="1"
                value={sector.emitters ?? 0}
                onChange={(e) => onUpdate({ ...sector, emitters: Number(e.target.value) })}
              />
            </label>
            <label>
              Caudal/emisor (L/h)
              <input
                type="number"
                min="1"
                value={sector.emitterFlow ?? 0}
                onChange={(e) => onUpdate({ ...sector, emitterFlow: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="vc-field-row">
            <label>
              Humedad mín (%)
              <input
                type="number"
                value={th.humidityMin}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, humidityMin: Number(e.target.value) } })}
              />
            </label>
            <label>
              Humedad máx (%)
              <input
                type="number"
                value={th.humidityMax}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, humidityMax: Number(e.target.value) } })}
              />
            </label>
          </div>
          <div className="vc-field-row">
            <label>
              CE mín (mS/cm)
              <input
                type="number"
                step="0.1"
                value={th.ecMin}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, ecMin: Number(e.target.value) } })}
              />
            </label>
            <label>
              CE máx (mS/cm)
              <input
                type="number"
                step="0.1"
                value={th.ecMax}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, ecMax: Number(e.target.value) } })}
              />
            </label>
          </div>
          <div className="vc-field-row">
            <label>
              Temp. mín (°C)
              <input
                type="number"
                value={th.temperatureMin ?? ""}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, temperatureMin: Number(e.target.value) } })}
              />
            </label>
            <label>
              Temp. máx (°C)
              <input
                type="number"
                value={th.temperatureMax ?? ""}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, temperatureMax: Number(e.target.value) } })}
              />
            </label>
          </div>
          <div className="vc-field-row">
            <label>
              Embozo si caudal &lt; (% nominal)
              <input
                type="number"
                min="1"
                max="99"
                value={th.flowMinPercent ?? 85}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, flowMinPercent: Number(e.target.value) } })}
              />
            </label>
            <label>
              Fuga leve si caudal &gt; (% nominal)
              <input
                type="number"
                min="101"
                value={th.flowMaxPercent ?? 115}
                onChange={(e) => onUpdate({ ...sector, thresholds: { ...th, flowMaxPercent: Number(e.target.value) } })}
              />
            </label>
          </div>
          <p className="vc-thresholds-note">
            ⚠ La presión de red ({presionBaja}–{presionAlta} bar) se comprueba siempre antes de aplicar estos umbrales: con la presión fuera de rango, el
            panel no diagnostica embozo ni fuga en esta línea, para evitar falsos avisos por falta de agua en origen.
          </p>
          {sector.lineaBackendId && (
            <div className="vc-field-row">
              <button className="vc-plano-btn-sm" disabled={guardandoConfig} onClick={onGuardarConfig}>
                {guardandoConfig ? "guardando…" : "guardar umbrales en el servidor"}
              </button>
              {avisoGuardarConfig && (
                <span style={{ fontSize: 11, marginLeft: 8, color: avisoGuardarConfig.ok ? "var(--vc-open)" : "var(--vc-red)" }}>
                  {avisoGuardarConfig.mensaje}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CollectorFlow({ lines }) {
  const count = Math.max(lines.length, 1);
  const width = Math.max(320, count * 90);
  const anyActive = lines.some((l) => l.active);
  const activeNames = lines.filter((l) => l.active).map((l) => l.name);
  return (
    <div>
      <svg viewBox={`0 0 ${width} 56`} width="100%" height="56" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="16" x2={width} y2="16" stroke="var(--vc-pipe)" strokeWidth="6" strokeLinecap="round" />
        {anyActive && (
          <line x1="0" y1="16" x2={width} y2="16" stroke="var(--vc-flow)" strokeWidth="3" strokeDasharray="10 10" strokeLinecap="round">
            <animate attributeName="stroke-dashoffset" from="0" to="-40" dur="0.8s" repeatCount="indefinite" />
          </line>
        )}
        {lines.map((l, i) => {
          const x = ((i + 0.5) / count) * width;
          const color = l.active ? "var(--vc-open)" : "var(--vc-pipe)";
          return (
            <g key={i}>
              <line x1={x} y1="16" x2={x} y2="34" stroke={color} strokeWidth={l.active ? 3 : 2} strokeLinecap="round" />
              <circle cx={x} cy="34" r={l.active ? 3.5 : 2.5} fill={color} />
              {l.active && (
                <text x={x} y="48" textAnchor="middle" fontSize="9" fontFamily="var(--vc-font-mono)" fill="var(--vc-open)">
                  {l.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="vc-collector-status">
        {activeNames.length > 0 ? `regando ahora: ${activeNames.join(", ")}` : "sin riego activo"}
      </div>
    </div>
  );
}

// Mini-calendario de un mes (7 columnas, empezando en lunes), con los días
// indicados en diasMarcados resaltados — usado para ver de un vistazo las
// fechas de mantenimiento programadas en el año.
function MiniCalendarMes({ anio, mes, diasMarcados }) {
  const primerDiaSemana = new Date(anio, mes, 1).getDay();
  const offset = (primerDiaSemana + 6) % 7; // 0 = lunes
  const diasEnMes = new Date(anio, mes + 1, 0).getDate();
  const celdas = [];
  for (let i = 0; i < offset; i++) celdas.push(null);
  for (let d = 1; d <= diasEnMes; d++) celdas.push(d);
  const nombreMes = new Date(anio, mes, 1).toLocaleDateString("es-ES", { month: "long" });
  const hoy = new Date();
  const esMesActual = hoy.getFullYear() === anio && hoy.getMonth() === mes;
  return (
    <div className="vc-mini-cal-mes">
      <div className="vc-mini-cal-mes-nombre">{nombreMes}</div>
      <div className="vc-mini-cal-grid">
        {["L", "M", "X", "J", "V", "S", "D"].map((d, i) => (
          <div className="vc-mini-cal-dow" key={i}>
            {d}
          </div>
        ))}
        {celdas.map((d, i) => {
          const esHoy = esMesActual && d === hoy.getDate();
          const marcado = d && diasMarcados.includes(d);
          return (
            <div
              className={
                marcado ? "vc-mini-cal-dia vc-mini-cal-dia-on" : esHoy ? "vc-mini-cal-dia vc-mini-cal-dia-hoy" : "vc-mini-cal-dia"
              }
              key={i}
            >
              {d || ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function PressureGauge({ bar, umbralSinAgua = 0.5, umbralBaja = 1.8, umbralAlta = 4.0, escalaMax = 6 }) {
  const min = 0;
  const max = escalaMax;
  const pct = clamp((bar - min) / (max - min), 0, 1);
  const angle = pct * 180 - 180;
  const ARC_D = "M 6 36 A 26 26 0 0 1 58 36";
  const L = 81.68; // longitud aproximada del arco completo (semicírculo de radio 26)
  // Zonas de alerta de presión, configuradas en Ajustes: por debajo de
  // umbralSinAgua sin agua, hasta umbralBaja presión baja, hasta umbralAlta
  // correcta, y por encima presión alta.
  const zonas = [
    { desde: 0, hasta: umbralSinAgua, color: "var(--vc-red)" },
    { desde: umbralSinAgua, hasta: umbralBaja, color: "var(--vc-amber)" },
    { desde: umbralBaja, hasta: umbralAlta, color: "var(--vc-flow)" },
    { desde: umbralAlta, hasta: max, color: "var(--vc-red)" },
  ];
  return (
    <svg width="64" height="46" viewBox="0 0 64 46" aria-hidden="true">
      <path d={ARC_D} fill="none" stroke="var(--vc-border)" strokeWidth="5" strokeLinecap="round" />
      {zonas.map((z, i) => {
        const start = (z.desde / max) * L;
        const len = ((z.hasta - z.desde) / max) * L;
        return (
          <path
            key={i}
            d={ARC_D}
            fill="none"
            stroke={z.color}
            strokeWidth="5"
            strokeLinecap={i === 0 || i === zonas.length - 1 ? "round" : "butt"}
            strokeDasharray={`${len} ${L}`}
            strokeDashoffset={-start}
          />
        );
      })}
      <g
        style={{
          transformOrigin: "32px 36px",
          transform: `rotate(${angle}deg)`,
          transition: "transform 0.6s ease",
        }}
      >
        <line x1="32" y1="36" x2="52" y2="36" stroke="var(--vc-brass)" strokeWidth="2" strokeLinecap="round" />
      </g>
      <circle cx="32" cy="36" r="2.5" fill="var(--vc-brass)" />
      <text x="6" y="44" fontSize="6" fill="var(--vc-text-muted)" textAnchor="middle">
        {min}
      </text>
      <text x="58" y="44" fontSize="6" fill="var(--vc-text-muted)" textAnchor="middle">
        {max}
      </text>
    </svg>
  );
}

function FertilizerGauge({ level, consumiendo }) {
  const color = level < 5 ? "var(--vc-red)" : level < 15 ? "var(--vc-amber)" : "var(--vc-violet)";
  const alturaLlena = (level / 100) * 26;
  const yLiquido = 34 - alturaLlena;
  return (
    <svg width="32" height="42" viewBox="0 0 30 40" aria-hidden="true" style={{ flexShrink: 0 }}>
      <defs>
        <clipPath id="vc-fert-clip">
          <rect x="6" y={yLiquido} width="18" height={alturaLlena} />
        </clipPath>
      </defs>
      <rect x="6" y="4" width="18" height="4" rx="1" fill="var(--vc-border)" />
      <rect x="4" y="8" width="22" height="28" rx="3" fill="none" stroke="var(--vc-border)" strokeWidth="2" />
      <rect x="6" y={yLiquido} width="18" height={alturaLlena} rx="1" fill={color} />
      {consumiendo && alturaLlena > 1.5 && (
        <g clipPath="url(#vc-fert-clip)">
          <g className="vc-fert-baja">
            <line x1="2" y1="-10" x2="32" y2="-2" stroke="rgba(255,255,255,0.4)" strokeWidth="2.2" />
            <line x1="2" y1="0" x2="32" y2="8" stroke="rgba(255,255,255,0.4)" strokeWidth="2.2" />
            <line x1="2" y1="10" x2="32" y2="18" stroke="rgba(255,255,255,0.4)" strokeWidth="2.2" />
            <line x1="2" y1="20" x2="32" y2="28" stroke="rgba(255,255,255,0.4)" strokeWidth="2.2" />
            <line x1="2" y1="30" x2="32" y2="38" stroke="rgba(255,255,255,0.4)" strokeWidth="2.2" />
            <line x1="2" y1="40" x2="32" y2="48" stroke="rgba(255,255,255,0.4)" strokeWidth="2.2" />
          </g>
        </g>
      )}
    </svg>
  );
}

function CombinedTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div
      style={{
        background: "var(--vc-panel-2)",
        border: "1px solid var(--vc-border)",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 11,
        fontFamily: "var(--vc-font-mono)",
        color: "var(--vc-text)",
      }}
    >
      <div style={{ color: "var(--vc-text-muted)", marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.value} {p.unit}
        </div>
      ))}
    </div>
  );
}

function CombinedLineChart({ data, height = 220 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid stroke="var(--vc-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: "var(--vc-text-muted)", fontSize: 10 }}
          interval="preserveStartEnd"
          minTickGap={40}
          axisLine={{ stroke: "var(--vc-border)" }}
          tickLine={false}
        />
        <YAxis
          yAxisId="humidity"
          domain={["auto", "auto"]}
          orientation="left"
          width={30}
          tick={{ fill: "var(--vc-flow)", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="ec"
          domain={["auto", "auto"]}
          orientation="left"
          width={30}
          tick={{ fill: "var(--vc-violet)", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="temperature"
          domain={["auto", "auto"]}
          orientation="right"
          width={30}
          tick={{ fill: "var(--vc-heat)", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="liters"
          domain={["auto", "auto"]}
          orientation="right"
          width={30}
          tick={{ fill: "var(--vc-brass)", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<CombinedTooltip />} />
        <Legend wrapperStyle={{ fontSize: 10, color: "var(--vc-text-muted)" }} />
        <Line
          yAxisId="humidity"
          type="monotone"
          dataKey="humidity"
          name="Humedad"
          unit="%"
          stroke="var(--vc-flow)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="temperature"
          type="monotone"
          dataKey="temperature"
          name="Temperatura"
          unit="°C"
          stroke="var(--vc-heat)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="ec"
          type="monotone"
          dataKey="ec"
          name="CE"
          unit="mS/cm"
          stroke="var(--vc-violet)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="liters"
          type="monotone"
          dataKey="liters"
          name="Agua acumulada hoy"
          unit="L"
          stroke="var(--vc-brass)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div
      style={{
        background: "var(--vc-panel-2)",
        border: "1px solid var(--vc-border)",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 11,
        fontFamily: "var(--vc-font-mono)",
        color: "var(--vc-text)",
      }}
    >
      <div style={{ color: "var(--vc-text-muted)", marginBottom: 2 }}>{label}</div>
      <div>
        {payload[0].value} {unit}
      </div>
    </div>
  );
}

function TrendChart({ data, color, unit, dataKey = "value", height = 130, umbralMin, umbralMax }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--vc-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: "var(--vc-text-muted)", fontSize: 10 }}
          interval="preserveStartEnd"
          minTickGap={40}
          axisLine={{ stroke: "var(--vc-border)" }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: "var(--vc-text)", fontSize: 11, fontWeight: 500 }}
          width={40}
          axisLine={false}
          tickLine={false}
          domain={[
            (dataMin) => (umbralMin !== undefined ? Math.min(dataMin, umbralMin) - 2 : dataMin),
            (dataMax) => (umbralMax !== undefined ? Math.max(dataMax, umbralMax) + 2 : dataMax),
          ]}
        />
        <Tooltip content={<ChartTooltip unit={unit} />} />
        {umbralMin !== undefined && (
          <ReferenceLine
            y={umbralMin}
            stroke="var(--vc-red)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{ value: `mín ${umbralMin}`, position: "insideBottomLeft", fill: "var(--vc-red)", fontSize: 9 }}
          />
        )}
        {umbralMax !== undefined && (
          <ReferenceLine
            y={umbralMax}
            stroke="var(--vc-red)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{ value: `máx ${umbralMax}`, position: "insideTopLeft", fill: "var(--vc-red)", fontSize: 9 }}
          />
        )}
        <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

const VENTANA_DIAS_HISTORICO = 30;

function ventanaDatos(data, offset, windowSize) {
  const total = data.length;
  const fin = Math.max(0, total - offset);
  const inicio = Math.max(0, fin - windowSize);
  return data.slice(inicio, fin);
}

function ChartNavBar({ offset, setOffset, total, windowSize }) {
  const puedeVerAnteriores = offset + windowSize < total;
  const puedeVerRecientes = offset > 0;
  const finVentana = Math.max(0, total - offset);
  const inicioVentana = Math.max(0, finVentana - windowSize);
  return (
    <div className="vc-chart-nav">
      <button
        className="vc-chart-nav-btn"
        disabled={!puedeVerAnteriores}
        onClick={() => setOffset((o) => Math.min(o + windowSize, Math.max(0, total - windowSize)))}
      >
        ← días anteriores
      </button>
      <span className="vc-chart-nav-label">
        {inicioVentana + 1}–{finVentana} de {total} días
      </span>
      <button className="vc-chart-nav-btn" disabled={!puedeVerRecientes} onClick={() => setOffset((o) => Math.max(0, o - windowSize))}>
        días siguientes →
      </button>
      {puedeVerRecientes && (
        <button className="vc-chart-nav-btn vc-chart-nav-hoy" onClick={() => setOffset(0)}>
          ir a hoy
        </button>
      )}
    </div>
  );
}

function DailyBarChart({ data, color, unit, height = 130, dataKey = "liters", todayColor = "var(--vc-flow)", onBarClick }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -8 }} barCategoryGap="20%" barGap={0}>
        <CartesianGrid stroke="var(--vc-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: "var(--vc-text-muted)", fontSize: 10 }}
          interval="preserveStartEnd"
          minTickGap={40}
          axisLine={{ stroke: "var(--vc-border)" }}
          tickLine={false}
        />
        <YAxis tick={{ fill: "var(--vc-text)", fontSize: 11, fontWeight: 500 }} width={40} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ fill: "var(--vc-panel-2)" }} />
        <Bar
          dataKey={dataKey}
          radius={[2, 2, 0, 0]}
          maxBarSize={16}
          onClick={onBarClick}
          style={onBarClick ? { cursor: "pointer" } : undefined}
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.isToday ? todayColor : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}


export default function VerdticalControlPanel() {
  const [sectors, setSectors] = useState(null);
  const [mainSupply, setMainSupply] = useState(true);
  const [pressureBar, setPressureBar] = useState(2.6);
  const [now, setNow] = useState(new Date());
  const [loaded, setLoaded] = useState(false);
  // Pantalla activa: 'lineas' (inicio, tarjetas de cada línea), 'plano',
  // 'programacion' (horarios) o 'ajustes' (técnico, cliente, historial...).
  // Se navega con la barra de pestañas de abajo, para no amontonar todo en
  // una sola pantalla.
  const [pantallaActiva, setPantallaActiva] = useState("lineas");
  const [proyecto, setProyecto] = useState({ nombre: "", direccion: "", lat: null, lon: null });
  const [showProyectoConfig, setShowProyectoConfig] = useState(false);
  // En el panel compartido (verdtical-panel.vercel.app) la pestaña del
  // navegador diría "Verdtical · panel" para todas las instalaciones por
  // igual — en cuanto se conoce el nombre real, se pone en la pestaña para
  // poder distinguir varias instalaciones abiertas a la vez.
  useEffect(() => {
    if (proyecto.nombre) document.title = `${proyecto.nombre} · Verdtical`;
  }, [proyecto.nombre]);
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);

  // Últimas lecturas reales del backend (por nombre de línea, ej. "Zona1").
  // Si una línea no aparece aquí (backend no disponible, o línea sin mapear
  // a Loxone todavía), se sigue usando la simulación local para ella.
  const [lecturasReales, setLecturasReales] = useState({});
  // Interruptor SOLO de pruebas: simula que se agota la batería de respaldo
  // del PLC (sin datos en absoluto), sin depender de la conexión real a
  // internet del dispositivo — así se puede probar sin desconectar el wifi.
  const [simulacionBateriaAgotada, setSimulacionBateriaAgotada] = useState(false);
  const [showAlarmHistory, setShowAlarmHistory] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showTecnicoConfig, setShowTecnicoConfig] = useState(false);
  const [showClienteConfig, setShowClienteConfig] = useState(false);
  // Qué tipos de alarma se evalúan de verdad en esta instalación — para
  // instalaciones con sensores incompletos (una línea sin sonda de humedad,
  // por ejemplo), donde esa alarma en concreto nunca se puede arreglar y no
  // tiene sentido que salte para siempre. Por defecto todo activo.
  const [alarmasInstalacion, setAlarmasInstalacion] = useState({});
  const [showAlarmasInstalacionConfig, setShowAlarmasInstalacionConfig] = useState(false);
  const [guardandoAlarmasInstalacion, setGuardandoAlarmasInstalacion] = useState(false);
  const [avisoAlarmasInstalacion, setAvisoAlarmasInstalacion] = useState(null);
  const [copiadoCliente, setCopiadoCliente] = useState(false);
  const [showFertilizerHistory, setShowFertilizerHistory] = useState(false);
  const [showRedHistory, setShowRedHistory] = useState(false);
  const [planoImagen, setPlanoImagen] = useState(null);
  const [lineaColocando, setLineaColocando] = useState(null);
  const [lineaResaltada, setLineaResaltada] = useState(null);
  const [showPlanoImagen, setShowPlanoImagen] = useState(false);
  const [showBalanceHidricoConfig, setShowBalanceHidricoConfig] = useState(false);
  const balanceHidricoDropdownRef = useRef(null);
  // Superficie calculada del plano real: zona grande 49,43 x 5,00 m + zona
  // pequeña 19,38 x 5,00 m = 344,05 m². Editable por si cambia la instalación.
  const [etoSol, setEtoSol] = useState(7);
  const [etoSemisombra, setEtoSemisombra] = useState(4.75);
  const [etoSombra, setEtoSombra] = useState(2.5);
  // Factores estacionales: multiplican el ETo base según la estación
  // (verano riega más, invierno mucho menos). Configurables, con los mismos
  // valores por defecto que tenía el panel fijos en el código.
  const [factoresEstacionales, setFactoresEstacionales] = useState({
    primavera: 0.75,
    verano: 1,
    otono: 0.55,
    invierno: 0.3,
  });
  const [umbralBalanceHidrico, setUmbralBalanceHidrico] = useState(30);
  const [wueGramosPorLitro, setWueGramosPorLitro] = useState(2.5);
  const [showAnnualWaterHistory, setShowAnnualWaterHistory] = useState(false);
  const [waterAnnualOffset, setWaterAnnualOffset] = useState(0);
  const [showAnnualFertilizerHistory, setShowAnnualFertilizerHistory] = useState(false);
  const [fertilizerAnnualOffset, setFertilizerAnnualOffset] = useState(0);
  const [selectedGlobalConsumoDay, setSelectedGlobalConsumoDay] = useState(null);
  const [showAnnualPressureHistory, setShowAnnualPressureHistory] = useState(false);
  const [pressureAnnualOffset, setPressureAnnualOffset] = useState(0);
  const [tecnico, setTecnico] = useState({
    nombre: "",
    telefono: "",
    email: "",
    emailAvisos: "",
    alarmas: { fugas: true, fallo_electrico: true, embozo: true, presion: true, humedad: true, ec: true, temperatura: true, multiples_lineas: true, fertilizante: true, maestra: true, corte_corriente: true, sin_datos: true, sin_agua: true },
  });
  const [cliente, setCliente] = useState({
    nombre: "",
    telefono: "",
    email: "",
    emailAvisos: "",
    alarmas: { fugas: false, fallo_electrico: false, embozo: false, presion: false, humedad: false, ec: false, temperatura: false, multiples_lineas: false, fertilizante: false, maestra: false, corte_corriente: false, sin_datos: false, sin_agua: false },
  });
  const [procesosRealizados, setProcesosRealizados] = useState({});
  const [notaObservacion, setNotaObservacion] = useState("");
  const [pressureAlert, setPressureAlert] = useState(null);
  const [multiLineAlert, setMultiLineAlert] = useState(null);
  const [fertilizerLevel, setFertilizerLevel] = useState(68);
  const [fertilizerAlert, setFertilizerAlert] = useState(null);
  const [fertilizerConsumedToday, setFertilizerConsumedToday] = useState(0);
  const [fertilizerDailyHistory, setFertilizerDailyHistory] = useState([]);
  const [fertilizerHourlyConsumption, setFertilizerHourlyConsumption] = useState(Array(24).fill(0));
  const [fertilizerHourlyHistory, setFertilizerHourlyHistory] = useState([]);
  const [selectedFertilizerDay, setSelectedFertilizerDay] = useState(null);
  // Configuración real del depósito y la dosis — antes estaban fijos en el
  // código (20 L de depósito, 1 mL de fertilizante por litro de agua);
  // ahora se pueden ajustar desde la pantalla de Ajustes según la
  // instalación real.
  const [fertilizerTanqueL, setFertilizerTanqueL] = useState(20);
  const [fertilizerDosisMlPorLitro, setFertilizerDosisMlPorLitro] = useState(1);
  // Umbrales de las zonas de alerta de presión (bar) — configurables desde
  // Ajustes. Por debajo de presionSinAgua: sin agua. Entre eso y
  // presionBaja: presión baja. Entre eso y presionAlta: correcta. Por
  // encima: presión alta. presionEscalaMax es el tope del manómetro.
  const [presionSinAgua, setPresionSinAgua] = useState(0.5);
  const [presionBaja, setPresionBaja] = useState(1.8);
  const [presionAlta, setPresionAlta] = useState(4.0);
  const [presionEscalaMax, setPresionEscalaMax] = useState(6);
  // Cada zona de presión avisa según su propia urgencia: sin agua es lo más
  // grave (menos horas de margen), presión alta/baja son menos urgentes.
  const [presionHorasSinAgua, setPresionHorasSinAgua] = useState(1);
  const [presionHorasBaja, setPresionHorasBaja] = useState(6);
  const [presionHorasAlta, setPresionHorasAlta] = useState(6);
  // Umbrales configurables del resto de alarmas globales (no ligadas a una
  // línea concreta): nivel de fertilizante bajo/agotado, y a partir de
  // cuántas líneas con incidencia simultánea se avisa de "varias líneas".
  const [fertilizanteUmbralBajo, setFertilizanteUmbralBajo] = useState(15);
  const [fertilizanteUmbralAgotado, setFertilizanteUmbralAgotado] = useState(5);
  const [multiplesLineasUmbral, setMultiplesLineasUmbral] = useState(3);
  const [fertilizanteHorasSostenidas, setFertilizanteHorasSostenidas] = useState(1);
  const [multiplesLineasHorasSostenidas, setMultiplesLineasHorasSostenidas] = useState(0.5);
  // Batería de respaldo del PLC: se descarga mientras dura un corte de
  // corriente real (o simulado con el botón de prueba), y se recarga en
  // cuanto vuelve la corriente. Al llegar a 0% se considera "sin datos".
  const [bateriaPlcNivel, setBateriaPlcNivel] = useState(100);
  const [bateriaUmbralBaja, setBateriaUmbralBaja] = useState(20);
  const [bateriaAutonomiaHoras, setBateriaAutonomiaHoras] = useState(4);
  const [plcSinCorriente, setPlcSinCorriente] = useState(false);
  // Umbral de caudal (% del nominal) y horas sostenidas para las alarmas de
  // rotura antes del colector, fuga leve y embozo — configurables aquí de
  // forma global; los umbrales de % de fuga leve/embozo por línea siguen
  // pudiendo ajustarse en cada tarjeta si hace falta un valor distinto.
  const [roturaColectorLitrosHora, setRoturaColectorLitrosHora] = useState(5);
  const [roturaColectorHorasSostenidas, setRoturaColectorHorasSostenidas] = useState(0.03);
  const [corteCorrienteHorasSostenidas, setCorteCorrienteHorasSostenidas] = useState(0);
  const [fugaLeveHorasSostenidas, setFugaLeveHorasSostenidas] = useState(0.5);
  const [embozoHorasSostenidas, setEmbozoHorasSostenidas] = useState(0.5);
  const [pressureDailyHistory, setPressureDailyHistory] = useState([]);
  const [pressureHourlyHistory, setPressureHourlyHistory] = useState([]);
  const pressureLastHourRef = useRef(null);
  const [pressureOutageLog, setPressureOutageLog] = useState([]);
  const pressureOutageActiveRef = useRef(false);
  const pressureSumTodayRef = useRef(0);
  const pressureCountTodayRef = useRef(0);
  const alarmDropdownRef = useRef(null);
  const activityDropdownRef = useRef(null);
  const tecnicoDropdownRef = useRef(null);
  const clienteDropdownRef = useRef(null);
  const [showMantenimientoConfig, setShowMantenimientoConfig] = useState(false);
  const [showAlarmasGlobalesConfig, setShowAlarmasGlobalesConfig] = useState(false);
  const [showPruebasBox, setShowPruebasBox] = useState(false);
  const [showEtoConfig, setShowEtoConfig] = useState(false);
  const etoDropdownRef = useRef(null);
  const [showDuracionTandaConfig, setShowDuracionTandaConfig] = useState(false);
  const [firmaDataUrl, setFirmaDataUrl] = useState(null);
  const [firmaFecha, setFirmaFecha] = useState(null);
  const firmaCanvasRef = useRef(null);
  const firmaDibujandoRef = useRef(false);
  const [firmaClienteDataUrl, setFirmaClienteDataUrl] = useState(null);
  const [firmaClienteFecha, setFirmaClienteFecha] = useState(null);
  const firmaClienteCanvasRef = useRef(null);
  const firmaClienteDibujandoRef = useRef(false);
  const duracionTandaDropdownRef = useRef(null);
  const pruebasDropdownRef = useRef(null);
  const alarmasGlobalesDropdownRef = useRef(null);
  const mantenimientoDropdownRef = useRef(null);
  const fertilizerDropdownRef = useRef(null);
  const redDropdownRef = useRef(null);
  const [showLitrosChart, setShowLitrosChart] = useState(false);
  const litrosDropdownRef = useRef(null);
  const [showPresionChart, setShowPresionChart] = useState(false);
  const presionDropdownRef = useRef(null);
  const [history, setHistory] = useState([]);
  const [flowHistory, setFlowHistory] = useState([]);
  const [pressureHistory, setPressureHistory] = useState([]);
  const [dailyConsumption, setDailyConsumption] = useState([]);
  // ¿Lo que hay en dailyConsumption es el histórico real del backend, o el
  // inventado de la demo? Arranca en false y solo pasa a true cuando el
  // bootstrap responde con días de verdad: ante la duda, no sumar.
  const [historialDiarioEsReal, setHistorialDiarioEsReal] = useState(false);
  // Caudalímetro GENERAL, instalado antes de todas las electroválvulas de
  // línea (a la entrada de la instalación). Sirve para detectar una pérdida
  // de agua que ninguna línea puede ver por su cuenta: rotura en la tubería
  // general, antes del colector.
  const [caudalGeneralMedido, setCaudalGeneralMedido] = useState(0);
  // Lectura real del contador general (si esta instalación tiene uno
  // asignado en Central) — cuando existe, manda sobre el cálculo por suma
  // de líneas de más abajo, porque es una medición de verdad, no un cálculo.
  const [caudalGeneralReal, setCaudalGeneralReal] = useState(null);
  // Solo para instalaciones con varios contadores (opcional, ver Central
  // "Contadores generales") — [] en cualquier instalación normal con un
  // único contador o sin ninguno.
  const [contadoresGenerales, setContadoresGenerales] = useState([]);
  // Protección de la ELECTROVÁLVULA MAESTRA: si el caudal general no
  // coincide con lo que suman las líneas activas, hay agua escapándose antes
  // de llegar a ninguna línea — se cierra la maestra y se avisa.
  const [maestraCerrada, setMaestraCerrada] = useState(null);
  const [confirmRearmeMaestra, setConfirmRearmeMaestra] = useState(false);
  const [leakAlerts, setLeakAlerts] = useState([]);
  const [alarmHistory, setAlarmHistory] = useState([]);
  const prevActiveRef = useRef({});
  const zeroFlowTicksRef = useRef({});
  const humedadLastHourRef = useRef({});
  const humedadSumTodayRef = useRef({});
  const humedadCountTodayRef = useRef({});
  const tempLastHourRef = useRef({});
  const tempSumTodayRef = useRef({});
  const tempCountTodayRef = useRef({});
  const ecLastHourRef = useRef({});
  const ecSumTodayRef = useRef({});
  const ecCountTodayRef = useRef({});
  const caudalLastHourRef = useRef({});
  const caudalSumTodayRef = useRef({});
  const caudalCountTodayRef = useRef({});
  const pressureSinAguaTicksRef = useRef(0);
  const pressureBajaTicksRef = useRef(0);
  const pressureAltaTicksRef = useRef(0);
  const fertilizerBajoTicksRef = useRef(0);
  const fertilizerAgotadoTicksRef = useRef(0);
  const multiLineTicksRef = useRef(0);
  const roturaColectorTicksRef = useRef(0);
  // Qué contadores generales (ver contadoresGenerales) ya tienen activo el
  // aviso de riego excesivo — evita repetir la misma alarma en cada ciclo de
  // 15s mientras la escorrentía se mantenga por encima del umbral.
  const riegoExcesivoAlertadoRef = useRef({});
  const bateriaBajaAlertadaRef = useRef(false);
  const fertilizerAlertedRef = useRef({ bajo: false, agotado: false });
  const sessionStartRef = useRef({});
  const lastDayRef = useRef(null);
  const MAX_PUNTOS_GRAFICA = 120;
  const MAX_DIAS_HISTORICO = 365;
  const MAX_DIAS_HORARIO = 14;
  const MAX_LECTURAS_PRESION_HORARIA = 7 * 24;
  const MAX_LECTURAS_HUMEDAD_HORARIA = 7 * 24;
  const MAX_LECTURAS_SENSOR_HORARIA = 7 * 24;
  const MAX_RIEGO_LOG = 150;
  const MAX_ALARM_LOG = 300;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        let [result, backend] = await Promise.all([
          window.storage.get(STORAGE_KEY),
          obtenerBootstrapProyecto(),
        ]);
        if ((!result || !result.value) && STORAGE_KEY !== STORAGE_KEY_BASE) {
          // Migración de paneles ya desplegados antes de que la clave llevara
          // el id de proyecto (jarcia-pnel, panel-naxamena, panel-pruebas):
          // si no hay nada bajo la clave nueva, se recupera lo que hubiera
          // bajo la antigua una única vez — a partir de aquí ya se guarda
          // siempre con la clave namespaced.
          const antiguo = await window.storage.get(STORAGE_KEY_BASE);
          if (antiguo && antiguo.value) result = antiguo;
        }
        const b = backend?.proyecto || {};
        const lineasBackend = backend?.lineas || null;
        const programasBackend = backend?.programas || null;
        const historialDiarioPorDia = transformarHistorialDiario(backend?.historialDiario);
        const fusionarConBackend = (sectores) =>
          (lineasBackend
            ? sectores.map((s, i) => fusionarLineaConBackend(s, buscarLineaBackend(lineasBackend, s.name, i)))
            : sectores
          ).map((s) => fusionarProgramacionConBackend(s, programasBackend));
        if (mounted && result && result.value) {
          const parsed = JSON.parse(result.value);
          // localStorage manda siempre; el backend solo rellena huecos (ver
          // Fase 2 del plan de unificación) — nunca pisa un valor ya guardado.
          const v = (campoLocal, campoBackend, def) =>
            parsed[campoLocal] !== undefined ? parsed[campoLocal] : b[campoBackend] ?? def;
          setSectors(fusionarConBackend(sanearLineasAlCargar(parsed.sectors) || defaultSectors()));
          setMainSupply(parsed.mainSupply !== undefined ? parsed.mainSupply : true);
          setPressureBar(v("pressureBar", "presion_bar", 2.6));
          setHistory(parsed.history || []);
          setFlowHistory(parsed.flowHistory || []);
          setPressureHistory(parsed.pressureHistory || []);
          setDailyConsumption(parsed.dailyConsumption && parsed.dailyConsumption.length > 0 ? parsed.dailyConsumption : demoDailyConsumption());
          setCaudalGeneralMedido(parsed.caudalGeneralMedido ?? 0);
          setMaestraCerrada(parsed.maestraCerrada ?? null);
          setLeakAlerts(parsed.leakAlerts || []);
          setAlarmHistory(parsed.alarmHistory || []);
          const tecnicoBackend = backend?.contactos?.tecnico;
          setTecnico({
            nombre: "",
            telefono: "",
            email: "",
            emailAvisos: "",
            ...(tecnicoBackend
              ? {
                  nombre: tecnicoBackend.nombre || "",
                  telefono: tecnicoBackend.telefono || "",
                  email: tecnicoBackend.email || "",
                  emailAvisos: tecnicoBackend.email_avisos || "",
                }
              : {}),
            ...(parsed.tecnico || {}),
            alarmas: {
              fugas: true,
              fallo_electrico: true,
              embozo: true,
              presion: true,
              humedad: true,
              ec: true,
              temperatura: true,
              multiples_lineas: true,
              fertilizante: true,
              maestra: true,
              corte_corriente: true,
              sin_datos: true,
              sin_agua: true,
              ...(tecnicoBackend?.alarmas || {}),
              ...(parsed.tecnico && parsed.tecnico.alarmas ? parsed.tecnico.alarmas : {}),
            },
          });
          const clienteBackend = backend?.contactos?.cliente;
          setCliente({
            nombre: "",
            telefono: "",
            email: "",
            emailAvisos: "",
            ...(clienteBackend
              ? {
                  nombre: clienteBackend.nombre || "",
                  telefono: clienteBackend.telefono || "",
                  email: clienteBackend.email || "",
                  emailAvisos: clienteBackend.email_avisos || "",
                }
              : {}),
            ...(parsed.cliente || {}),
            alarmas: {
              fugas: false,
              fallo_electrico: false,
              embozo: false,
              presion: false,
              humedad: false,
              ec: false,
              temperatura: false,
              multiples_lineas: false,
              fertilizante: false,
              maestra: false,
              corte_corriente: false,
              sin_datos: false,
              sin_agua: false,
              ...(clienteBackend?.alarmas || {}),
              ...(parsed.cliente && parsed.cliente.alarmas ? parsed.cliente.alarmas : {}),
            },
          });
          setAlarmasInstalacion({ ...(b.alarmas_activas || {}), ...(parsed.alarmasInstalacion || {}) });
          setProcesosRealizados(parsed.procesosRealizados || {});
          setPlanoImagen(parsed.planoImagen || backend?.plano?.imagen || null);
          setEtoSol(v("etoSol", "eto_sol", 7));
          setEtoSemisombra(v("etoSemisombra", "eto_semisombra", 4.75));
          setEtoSombra(v("etoSombra", "eto_sombra", 2.5));
          setFactoresEstacionales(
            parsed.factoresEstacionales || {
              primavera: b.factor_primavera ?? 0.75,
              verano: b.factor_verano ?? 1,
              otono: b.factor_otono ?? 0.55,
              invierno: b.factor_invierno ?? 0.3,
            }
          );
          setUmbralBalanceHidrico(v("umbralBalanceHidrico", "umbral_balance_hidrico", 30));
          setWueGramosPorLitro(v("wueGramosPorLitro", "wue_gramos_por_litro", 2.5));
          setNotaObservacion(parsed.notaObservacion || "");
          setPressureAlert(parsed.pressureAlert || null);
          setMultiLineAlert(null);
          setFertilizerLevel(parsed.fertilizerLevel !== undefined ? parsed.fertilizerLevel : 68);
          setFertilizerAlert(parsed.fertilizerAlert || null);
          setFertilizerConsumedToday(parsed.fertilizerConsumedToday || 0);
          setFertilizerDailyHistory(
            parsed.fertilizerDailyHistory && parsed.fertilizerDailyHistory.length > 0
              ? parsed.fertilizerDailyHistory
              : demoFertilizerHistory()
          );
          setFertilizerHourlyConsumption(
            Array.isArray(parsed.fertilizerHourlyConsumption) ? parsed.fertilizerHourlyConsumption : Array(24).fill(0)
          );
          setFertilizerHourlyHistory(parsed.fertilizerHourlyHistory || []);
          setFertilizerTanqueL(v("fertilizerTanqueL", "fertilizante_tanque_l", 20));
          setFertilizerDosisMlPorLitro(v("fertilizerDosisMlPorLitro", "fertilizante_dosis_ml_por_litro", 1));
          setPresionSinAgua(v("presionSinAgua", "presion_sin_agua", 0.5));
          setPresionBaja(v("presionBaja", "presion_baja", 1.8));
          setPresionAlta(v("presionAlta", "presion_alta", 4.0));
          setPresionEscalaMax(v("presionEscalaMax", "presion_escala_max", 6));
          setPresionHorasSinAgua(v("presionHorasSinAgua", "presion_horas_sin_agua", 1));
          setPresionHorasBaja(v("presionHorasBaja", "presion_horas_baja", 6));
          setPresionHorasAlta(v("presionHorasAlta", "presion_horas_alta", 6));
          setFertilizanteUmbralBajo(v("fertilizanteUmbralBajo", "fertilizante_umbral_bajo", 15));
          setFertilizanteUmbralAgotado(v("fertilizanteUmbralAgotado", "fertilizante_umbral_agotado", 5));
          setMultiplesLineasUmbral(v("multiplesLineasUmbral", "multiples_lineas_umbral", 3));
          setFertilizanteHorasSostenidas(v("fertilizanteHorasSostenidas", "fertilizante_horas_sostenidas", 1));
          setMultiplesLineasHorasSostenidas(v("multiplesLineasHorasSostenidas", "multiples_lineas_horas_sostenidas", 0.5));
          setBateriaPlcNivel(parsed.bateriaPlcNivel !== undefined ? parsed.bateriaPlcNivel : 100);
          setBateriaUmbralBaja(v("bateriaUmbralBaja", "bateria_umbral_baja", 20));
          setBateriaAutonomiaHoras(v("bateriaAutonomiaHoras", "bateria_autonomia_horas", 4));
          setRoturaColectorLitrosHora(v("roturaColectorLitrosHora", "rotura_colector_litros_hora", 5));
          setRoturaColectorHorasSostenidas(v("roturaColectorHorasSostenidas", "rotura_colector_horas_sostenidas", 0.03));
          setCorteCorrienteHorasSostenidas(v("corteCorrienteHorasSostenidas", "corte_corriente_horas_sostenidas", 0));
          setFugaLeveHorasSostenidas(v("fugaLeveHorasSostenidas", "fuga_leve_horas_sostenidas", 0.5));
          setEmbozoHorasSostenidas(v("embozoHorasSostenidas", "embozo_horas_sostenidas", 0.5));
          bateriaBajaAlertadaRef.current = parsed.bateriaBajaAlertada || false;
          setFirmaDataUrl(parsed.firmaDataUrl || null);
          setFirmaFecha(parsed.firmaFecha || null);
          setFirmaClienteDataUrl(parsed.firmaClienteDataUrl || null);
          setFirmaClienteFecha(parsed.firmaClienteFecha || null);
          fertilizerAlertedRef.current = parsed.fertilizerAlerted || { bajo: false, agotado: false };
          setPressureDailyHistory(
            parsed.pressureDailyHistory && parsed.pressureDailyHistory.length > 0
              ? parsed.pressureDailyHistory
              : demoPressureHistory()
          );
          pressureSumTodayRef.current = parsed.pressureSumToday || 0;
          pressureCountTodayRef.current = parsed.pressureCountToday || 0;
          setPressureOutageLog(parsed.pressureOutageLog || []);
          setPressureHourlyHistory(parsed.pressureHourlyHistory || demoPressureHourly());
        } else if (mounted) {
          // Sin nada en localStorage (navegador/dispositivo nuevo): el
          // backend es la única fuente de configuración real disponible.
          // Si ya hay líneas reales sincronizadas, el panel arranca con
          // exactamente esas — nunca con las 8 de defaultSectors() (pensadas
          // para Jarcia), que dejarían líneas "fantasma" sin datos reales si
          // esta instalación tiene un número distinto de líneas.
          setSectors(
            lineasBackend && lineasBackend.length > 0
              ? lineasBackend.map(construirSectorDesdeLineaBackend)
              : fusionarConBackend(defaultSectors())
          );
          setDailyConsumption(demoDailyConsumption());
          setFertilizerDailyHistory(demoFertilizerHistory());
          setPressureDailyHistory(demoPressureHistory());
          setPressureHourlyHistory(demoPressureHourly());
          if (backend?.proyecto) {
            setPressureBar(b.presion_bar ?? 2.6);
            setEtoSol(b.eto_sol ?? 7);
            setEtoSemisombra(b.eto_semisombra ?? 4.75);
            setEtoSombra(b.eto_sombra ?? 2.5);
            setFactoresEstacionales({
              primavera: b.factor_primavera ?? 0.75,
              verano: b.factor_verano ?? 1,
              otono: b.factor_otono ?? 0.55,
              invierno: b.factor_invierno ?? 0.3,
            });
            setUmbralBalanceHidrico(b.umbral_balance_hidrico ?? 30);
            setWueGramosPorLitro(b.wue_gramos_por_litro ?? 2.5);
            setFertilizerTanqueL(b.fertilizante_tanque_l ?? 20);
            setFertilizerDosisMlPorLitro(b.fertilizante_dosis_ml_por_litro ?? 1);
            setPresionSinAgua(b.presion_sin_agua ?? 0.5);
            setPresionBaja(b.presion_baja ?? 1.8);
            setPresionAlta(b.presion_alta ?? 4.0);
            setPresionEscalaMax(b.presion_escala_max ?? 6);
            setPresionHorasSinAgua(b.presion_horas_sin_agua ?? 1);
            setPresionHorasBaja(b.presion_horas_baja ?? 6);
            setPresionHorasAlta(b.presion_horas_alta ?? 6);
            setFertilizanteUmbralBajo(b.fertilizante_umbral_bajo ?? 15);
            setFertilizanteUmbralAgotado(b.fertilizante_umbral_agotado ?? 5);
            setMultiplesLineasUmbral(b.multiples_lineas_umbral ?? 3);
            setFertilizanteHorasSostenidas(b.fertilizante_horas_sostenidas ?? 1);
            setMultiplesLineasHorasSostenidas(b.multiples_lineas_horas_sostenidas ?? 0.5);
            setBateriaUmbralBaja(b.bateria_umbral_baja ?? 20);
            setBateriaAutonomiaHoras(b.bateria_autonomia_horas ?? 4);
            setRoturaColectorLitrosHora(b.rotura_colector_litros_hora ?? 5);
            setRoturaColectorHorasSostenidas(b.rotura_colector_horas_sostenidas ?? 0.03);
            setCorteCorrienteHorasSostenidas(b.corte_corriente_horas_sostenidas ?? 0);
            setFugaLeveHorasSostenidas(b.fuga_leve_horas_sostenidas ?? 0.5);
            setEmbozoHorasSostenidas(b.embozo_horas_sostenidas ?? 0.5);
          }
          if (backend?.contactos?.tecnico) {
            const t = backend.contactos.tecnico;
            setTecnico((prev) => ({
              ...prev,
              nombre: t.nombre || prev.nombre,
              telefono: t.telefono || prev.telefono,
              email: t.email || prev.email,
              emailAvisos: t.email_avisos || prev.emailAvisos,
              alarmas: { ...prev.alarmas, ...(t.alarmas || {}) },
            }));
          }
          if (backend?.contactos?.cliente) {
            const c = backend.contactos.cliente;
            setCliente((prev) => ({
              ...prev,
              nombre: c.nombre || prev.nombre,
              telefono: c.telefono || prev.telefono,
              email: c.email || prev.email,
              emailAvisos: c.email_avisos || prev.emailAvisos,
              alarmas: { ...prev.alarmas, ...(c.alarmas || {}) },
            }));
          }
          if (b.alarmas_activas) {
            setAlarmasInstalacion(b.alarmas_activas);
          }
          if (backend?.plano?.imagen) {
            setPlanoImagen(backend.plano.imagen);
          }
        }
        // El nombre/dirección de la instalación viene siempre del backend
        // (se edita en Verdtical Central) — nunca de localStorage: no tiene
        // sentido que un técnico lo escriba a mano en cada dispositivo.
        if (mounted) {
          setProyecto({
            nombre: b.nombre || "",
            direccion: b.direccion || "",
            lat: b.lat ?? null,
            lon: b.lon ?? null,
          });
        }
        // Historial diario real (servidor) — sustituye al archivado local
        // (que solo funcionaba si el panel seguía abierto justo al cambiar
        // de día) en cuanto hay datos reales que mostrar. Total de la
        // instalación y desglose por línea, para la gráfica y su desplegable
        // "consumo por línea" al pulsar un día.
        if (mounted && historialDiarioPorDia.length > 0) {
          setDailyConsumption(
            historialDiarioPorDia.map((d) => ({ date: d.date, label: d.label, liters: Math.round(d.total) }))
          );
          // A partir de aquí el histórico es real, así que sí se puede sumar
          // al total de hoy (ver totalLitrosHistorico).
          setHistorialDiarioEsReal(true);
          setSectors((prev) =>
            prev.map((s) => {
              if (!s.lineaBackendId) return s;
              const historialLinea = historialDiarioPorDia
                .filter((d) => d.porLinea[s.lineaBackendId] !== undefined)
                .map((d) => ({ date: d.date, label: d.label, liters: Math.round(d.porLinea[s.lineaBackendId]) }));
              if (historialLinea.length === 0) return s;
              return { ...s, dailyConsumption: historialLinea };
            })
          );
        }
      } catch (err) {
        if (mounted) setSectors(defaultSectors());
      } finally {
        if (mounted) setLoaded(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelado = false;
    const actualizar = async () => {
      const [datos, general, generales] = await Promise.all([
        obtenerUltimasLecturas(),
        obtenerCaudalGeneral(),
        obtenerContadoresGenerales(),
      ]);
      if (datos && !cancelado) setLecturasReales(datos);
      if (!cancelado) setCaudalGeneralReal(general);
      if (!cancelado && generales) setContadoresGenerales(generales);
    };
    actualizar();
    // A juego con el intervalo de lectura del worker (15s) — si no, aunque
    // el servidor tuviera datos más frescos, el panel seguiría enseñando
    // una foto de hasta un minuto de antigüedad.
    const interval = setInterval(actualizar, 15000);
    return () => {
      cancelado = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // "datosActivos" combina la conexión real del navegador con el
  // interruptor de pruebas de batería agotada — es lo que de verdad decide
  // si hay datos o no, en vez de usar isOnline directamente en todos lados.
  const datosActivos = isOnline && !simulacionBateriaAgotada && bateriaPlcNivel > 0;

  // La falta de datos es un problema del PANEL viendo el sistema, no del
  // sistema en sí: el PLC sigue regando aunque el panel se quede a ciegas
  // por un fallo de internet o batería. Por eso NO se toca "sistema
  // activado/apagado" aquí — solo se avisa y se congela lo que se MUESTRA
  // (ver el otro efecto), hasta que vuelvan los datos.
  const sinDatosAvisadoRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (alarmasInstalacion?.sin_datos === false) return;
    if (!datosActivos && !sinDatosAvisadoRef.current) {
      sinDatosAvisadoRef.current = true;
      setAlarmHistory((prev) =>
        [
          { id: `alarm-conexion-${Date.now()}`, ts: new Date().toISOString(), lineId: null, lineName: "Sistema general", type: "fallo_conexion" },
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
    } else if (datosActivos && sinDatosAvisadoRef.current) {
      sinDatosAvisadoRef.current = false;
      setAlarmHistory((prev) =>
        [
          { id: `alarm-conexion-ok-${Date.now()}`, ts: new Date().toISOString(), lineId: null, lineName: "Sistema general", type: "fallo_conexion_resuelto" },
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datosActivos, loaded]);

  // Carga/descarga de la batería del PLC — en un efecto APARTE del resto de
  // sensores, para que siga funcionando aunque la batería llegue a 0% y todo
  // lo demás se congele por falta de datos (si no, nunca podría recargarse).
  useEffect(() => {
    if (!loaded) return;
    if (plcSinCorriente) {
      const tasaPorTick = 100 / Math.max(1, (bateriaAutonomiaHoras * 3600) / 15);
      const nuevoNivelBateria = Math.max(0, Math.round((bateriaPlcNivel - tasaPorTick) * 10) / 10);
      setBateriaPlcNivel(nuevoNivelBateria);
      if (alarmasInstalacion?.corte_corriente !== false && nuevoNivelBateria <= bateriaUmbralBaja && !bateriaBajaAlertadaRef.current) {
        bateriaBajaAlertadaRef.current = true;
        setAlarmHistory((prev) =>
          [
            {
              id: `alarm-bateria-${Date.now()}`,
              ts: new Date().toISOString(),
              lineId: null,
              lineName: "Batería del PLC",
              type: "bateria_baja",
              value: nuevoNivelBateria,
              umbral: bateriaUmbralBaja,
            },
            ...prev,
          ].slice(0, MAX_ALARM_LOG)
        );
      }
    } else if (bateriaPlcNivel < 100) {
      setBateriaPlcNivel(100);
      bateriaBajaAlertadaRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, loaded, plcSinCorriente]);

  useEffect(() => {
    if (!showAlarmHistory && !showActivityLog && !showTecnicoConfig && !showClienteConfig && !showFertilizerHistory && !showRedHistory && !showLitrosChart && !showPresionChart && !showMantenimientoConfig && !showAlarmasGlobalesConfig && !showPruebasBox && !showEtoConfig && !showDuracionTandaConfig && !showBalanceHidricoConfig) return;
    const handleClickOutside = (e) => {
      if (showAlarmHistory && alarmDropdownRef.current && !alarmDropdownRef.current.contains(e.target)) {
        setShowAlarmHistory(false);
      }
      if (showActivityLog && activityDropdownRef.current && !activityDropdownRef.current.contains(e.target)) {
        setShowActivityLog(false);
      }
      if (showTecnicoConfig && tecnicoDropdownRef.current && !tecnicoDropdownRef.current.contains(e.target)) {
        setShowTecnicoConfig(false);
      }
      if (showClienteConfig && clienteDropdownRef.current && !clienteDropdownRef.current.contains(e.target)) {
        setShowClienteConfig(false);
      }
      if (showFertilizerHistory && fertilizerDropdownRef.current && !fertilizerDropdownRef.current.contains(e.target)) {
        setShowFertilizerHistory(false);
      }
      if (showRedHistory && redDropdownRef.current && !redDropdownRef.current.contains(e.target)) {
        setShowRedHistory(false);
      }
      if (showLitrosChart && litrosDropdownRef.current && !litrosDropdownRef.current.contains(e.target)) {
        setShowLitrosChart(false);
      }
      if (showPresionChart && presionDropdownRef.current && !presionDropdownRef.current.contains(e.target)) {
        setShowPresionChart(false);
      }
      if (showMantenimientoConfig && mantenimientoDropdownRef.current && !mantenimientoDropdownRef.current.contains(e.target)) {
        setShowMantenimientoConfig(false);
      }
      if (showAlarmasGlobalesConfig && alarmasGlobalesDropdownRef.current && !alarmasGlobalesDropdownRef.current.contains(e.target)) {
        setShowAlarmasGlobalesConfig(false);
      }
      if (showPruebasBox && pruebasDropdownRef.current && !pruebasDropdownRef.current.contains(e.target)) {
        setShowPruebasBox(false);
      }
      if (showEtoConfig && etoDropdownRef.current && !etoDropdownRef.current.contains(e.target)) {
        setShowEtoConfig(false);
      }
      if (showDuracionTandaConfig && duracionTandaDropdownRef.current && !duracionTandaDropdownRef.current.contains(e.target)) {
        setShowDuracionTandaConfig(false);
      }
      if (showBalanceHidricoConfig && balanceHidricoDropdownRef.current && !balanceHidricoDropdownRef.current.contains(e.target)) {
        setShowBalanceHidricoConfig(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAlarmHistory, showActivityLog, showTecnicoConfig, showClienteConfig, showFertilizerHistory, showRedHistory, showLitrosChart, showPresionChart, showMantenimientoConfig, showAlarmasGlobalesConfig, showPruebasBox, showEtoConfig, showDuracionTandaConfig, showBalanceHidricoConfig]);

  useEffect(() => {
    if (!loaded || !sectors) return;
    const save = async () => {
      try {
        await window.storage.set(
          STORAGE_KEY,
          JSON.stringify({
            sectors,
            mainSupply,
            pressureBar,
            history: history.slice(0, 20),
            flowHistory: flowHistory.slice(-MAX_PUNTOS_GRAFICA),
            pressureHistory: pressureHistory.slice(-MAX_PUNTOS_GRAFICA),
            dailyConsumption: dailyConsumption.slice(-MAX_DIAS_HISTORICO),
            caudalGeneralMedido,
            maestraCerrada,
            leakAlerts,
            alarmHistory: alarmHistory.slice(-MAX_ALARM_LOG),
            tecnico,
            cliente,
            alarmasInstalacion,
            procesosRealizados,
            notaObservacion,
            proyecto,
            planoImagen,
            etoSol,
            etoSemisombra,
            etoSombra,
            factoresEstacionales,
            umbralBalanceHidrico,
            wueGramosPorLitro,
            pressureAlert,
            multiLineAlert,
            fertilizerLevel,
            fertilizerAlert,
            fertilizerAlerted: fertilizerAlertedRef.current,
            fertilizerConsumedToday,
            fertilizerDailyHistory: fertilizerDailyHistory.slice(-MAX_DIAS_HISTORICO),
            fertilizerHourlyConsumption,
            fertilizerHourlyHistory: fertilizerHourlyHistory.slice(-MAX_DIAS_HORARIO),
            fertilizerTanqueL,
            fertilizerDosisMlPorLitro,
            presionSinAgua,
            presionBaja,
            presionAlta,
            presionEscalaMax,
            presionHorasSinAgua,
            presionHorasBaja,
            presionHorasAlta,
            fertilizanteUmbralBajo,
            fertilizanteUmbralAgotado,
            multiplesLineasUmbral,
            fertilizanteHorasSostenidas,
            multiplesLineasHorasSostenidas,
            bateriaPlcNivel,
            bateriaUmbralBaja,
            bateriaAutonomiaHoras,
            roturaColectorLitrosHora,
            roturaColectorHorasSostenidas,
            corteCorrienteHorasSostenidas,
            fugaLeveHorasSostenidas,
            embozoHorasSostenidas,
            bateriaBajaAlertada: bateriaBajaAlertadaRef.current,
            firmaDataUrl,
            firmaFecha,
            firmaClienteDataUrl,
            firmaClienteFecha,
            pressureDailyHistory: pressureDailyHistory.slice(-MAX_DIAS_HISTORICO),
            pressureSumToday: pressureSumTodayRef.current,
            pressureCountToday: pressureCountTodayRef.current,
            pressureOutageLog: pressureOutageLog.slice(-200),
            pressureHourlyHistory: pressureHourlyHistory.slice(-MAX_LECTURAS_PRESION_HORARIA),
          })
        );
      } catch (err) {
        // fallo silencioso de guardado; el estado local sigue siendo válido
      }
    };
    save();
  }, [
    sectors,
    mainSupply,
    pressureBar,
    history,
    flowHistory,
    pressureHistory,
    dailyConsumption,
    caudalGeneralMedido,
    maestraCerrada,
    leakAlerts,
    alarmHistory,
    tecnico,
    cliente,
    alarmasInstalacion,
    procesosRealizados,
    notaObservacion,
    proyecto,
    planoImagen,
    etoSol,
    etoSemisombra,
    etoSombra,
    factoresEstacionales,
    umbralBalanceHidrico,
    wueGramosPorLitro,
    pressureAlert,
    multiLineAlert,
    fertilizerLevel,
    fertilizerAlert,
    fertilizerConsumedToday,
    fertilizerDailyHistory,
    fertilizerHourlyConsumption,
    fertilizerHourlyHistory,
    fertilizerTanqueL,
    fertilizerDosisMlPorLitro,
    presionSinAgua,
    presionBaja,
    presionAlta,
    presionEscalaMax,
    presionHorasSinAgua,
    presionHorasBaja,
    presionHorasAlta,
    fertilizanteUmbralBajo,
    fertilizanteUmbralAgotado,
    multiplesLineasUmbral,
    fertilizanteHorasSostenidas,
    multiplesLineasHorasSostenidas,
    bateriaPlcNivel,
    bateriaUmbralBaja,
    bateriaAutonomiaHoras,
    roturaColectorLitrosHora,
    roturaColectorHorasSostenidas,
    corteCorrienteHorasSostenidas,
    fugaLeveHorasSostenidas,
    embozoHorasSostenidas,
    firmaDataUrl,
    firmaFecha,
    firmaClienteDataUrl,
    firmaClienteFecha,
    pressureDailyHistory,
    pressureOutageLog,
    pressureHourlyHistory,
    loaded,
  ]);

  useEffect(() => {
    if (!sectors) return;
    // Los sensores (humedad, presión, caudal) siguen llegando aunque el
    // sistema esté "apagado" — con batería de respaldo en el PLC, se sigue
    // recibiendo información aunque no se pueda activar ninguna
    // electroválvula sin corriente. Lo único que congela TODO de verdad es
    // la falta de datos en sí (batería agotada o comunicación perdida).
    if (!datosActivos) return;
    const nextActive = {};
    const newEvents = [];
    const riegoManualExpirado = [];
    const leaksDetectados = [];
    const fugasLeves = [];
    const fallosElectricos = [];
    const embozosNuevos = [];
    const humedadNuevos = [];
    const ecNuevos = [];
    const temperaturaNuevos = [];
    let anyActiveCount = 0;

    // La presión de red condiciona si se puede fiar el diagnóstico de caudal por
    // línea: por debajo o por encima del rango configurado (presionBaja/
    // presionAlta, en Configuración de alarmas) los emisores autocompensantes
    // no entregan su caudal nominal aunque no tengan ninguna avería, así que
    // el embozo/fuga/fallo eléctrico solo se evalúa si la presión del ciclo
    // anterior estaba dentro de ese rango.
    const presionEnRangoTrabajo = pressureBar >= presionBaja && pressureBar <= presionAlta;

    const label = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const todayStr = now.toDateString();
    let dayChanged = false;
    let fechaAnterior = null;

    if (lastDayRef.current === null) {
      lastDayRef.current = todayStr;
    } else if (lastDayRef.current !== todayStr) {
      dayChanged = true;
      fechaAnterior = lastDayRef.current;
      const totalDiaAnterior = sectors.reduce((sum, s) => sum + Number(s.sensors?.litersToday || 0), 0);
      setDailyConsumption((prev) =>
        [
          ...prev,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            liters: Math.round(totalDiaAnterior),
          },
        ].slice(-MAX_DIAS_HISTORICO)
      );
      lastDayRef.current = todayStr;
    }

    const updated = sectors.map((s, indiceLinea) => {
      let manualOverride = s.manualOverride;
      if (manualOverride && manualOverride.active && new Date(manualOverride.endsAt).getTime() <= now.getTime()) {
        newEvents.push({ ts: now.toISOString(), text: `${s.name}: riego manual finalizado (tiempo agotado)` });
        if (s.lineaBackendId) riegoManualExpirado.push({ nombre: s.name, lineaBackendId: s.lineaBackendId });
        manualOverride = null;
      }
      const sConManual = manualOverride === s.manualOverride ? s : { ...s, manualOverride };

      // Si hay caudal real (de la última lectura), la línea está regando de
      // verdad aunque el horario de la demo no lo prevea — el dato real
      // manda sobre la simulación de horarios.
      const active =
        (mainSupply && !maestraCerrada && isSectorActiveNow(sConManual, now)) || Number(s.sensors?.flowMeasured || 0) > 0;
      nextActive[s.id] = active;
      if (active) anyActiveCount += 1;
      const wasActive = prevActiveRef.current[s.id];
      if (wasActive !== undefined) {
        if (active && !wasActive) {
          newEvents.push({ ts: now.toISOString(), text: `${s.name}: válvula abierta` });
          const tipo = isManualOverrideActive(sConManual, now) ? "manual" : s.mode === "sensor" ? "sensor" : "horario";
          sessionStartRef.current[s.id] = {
            startTs: now.toISOString(),
            litersAtStart: Number(s.sensors?.litersToday || 0),
            tipo,
          };
        } else if (!active && wasActive) {
          newEvents.push({ ts: now.toISOString(), text: `${s.name}: válvula cerrada` });
        }
      }
      // s.lineaBackendId manda: sin él, un nombre que no case dejaba el
      // emparejamiento en manos de la posición, que puede señalar otra línea.
      const lecturaReal = buscarLectura(lecturasReales, s.name, indiceLinea, s.lineaBackendId);
      let sim = lecturaReal
        ? {
            humidity: lecturaReal.humidity ?? s.sensors?.humidity ?? 45,
            ec: lecturaReal.ec ?? s.sensors?.ec ?? 1.8,
            temperature: lecturaReal.temperature ?? s.sensors?.temperature ?? 21,
            flowMeasured: lecturaReal.flowMeasured ?? 0,
          }
        : simulateSector(s, active, now.getHours() + now.getMinutes() / 60);

      const nominalFlow = Number(s.emitters || 0) * Number(s.emitterFlow || 0);

      // Simulación de fallo eléctrico/mecánico ocasional: la válvula no responde
      // (caudal 0 estando programada). Esto solo debe verse en la demo o en una
      // instalación real conectada; aquí se simula con una probabilidad muy baja.
      if (active && Math.random() < 0.003) {
        sim = { ...sim, flowMeasured: 0 };
      }

      let blockedByLeak = s.blockedByLeak || false;
      let minorLeakFlag = s.minorLeakFlag || false;
      let clogFlag = s.clogFlag || false;
      let fugaLeveTicks = s.fugaLeveTicks || 0;
      let embozoTicks = s.embozoTicks || 0;
      let flowAlarmLog = s.flowAlarmLog || [];
      if (active && nominalFlow > 0 && presionEnRangoTrabajo) {
        const flowMinPct = (s.thresholds?.flowMinPercent ?? 85) / 100;
        const flowMaxPct = (s.thresholds?.flowMaxPercent ?? 115) / 100;
        // alarmasInstalacion desactiva por completo un tipo de alarma para
        // toda la instalación — ver "Alarmas activas" en Configuración.
        const fugasActivasAqui = alarmasInstalacion?.fugas !== false;
        const embozoActivoAqui = alarmasInstalacion?.embozo !== false;
        const esGrave = fugasActivasAqui && sim.flowMeasured >= nominalFlow * 1.5;
        const esLeve = fugasActivasAqui && !esGrave && sim.flowMeasured >= nominalFlow * flowMaxPct;
        const esEmbozo = embozoActivoAqui && sim.flowMeasured < nominalFlow * flowMinPct;
        const porcentajeActual = Math.round((sim.flowMeasured / nominalFlow) * 100);
        const ciclosFugaLeveNecesarios = Math.max(1, Math.round((fugaLeveHorasSostenidas * 3600) / 15));
        const ciclosEmbozoNecesarios = Math.max(1, Math.round((embozoHorasSostenidas * 3600) / 15));
        if (!blockedByLeak && esGrave) {
          blockedByLeak = true;
          leaksDetectados.push({ id: s.id, name: s.name, flowMeasured: sim.flowMeasured, nominalFlow });
          flowAlarmLog = [
            { ts: now.toISOString(), tipo: "fuga_grave", flowMeasured: sim.flowMeasured, nominalFlow, porcentaje: porcentajeActual },
            ...flowAlarmLog,
          ].slice(0, 100);
        }
        // La fuga leve y el embozo solo avisan si se mantienen de forma
        // sostenida durante las horas configuradas (no ante una lectura
        // puntual), igual que el resto de alarmas globales.
        fugaLeveTicks = esLeve ? fugaLeveTicks + 1 : 0;
        if (fugaLeveTicks >= ciclosFugaLeveNecesarios && !minorLeakFlag) {
          minorLeakFlag = true;
          fugasLeves.push({ id: s.id, name: s.name, flowMeasured: sim.flowMeasured, nominalFlow });
          flowAlarmLog = [
            { ts: now.toISOString(), tipo: "fuga_leve", flowMeasured: sim.flowMeasured, nominalFlow, porcentaje: porcentajeActual },
            ...flowAlarmLog,
          ].slice(0, 100);
        } else if (!esLeve && !esGrave) {
          minorLeakFlag = false;
        }
        embozoTicks = esEmbozo ? embozoTicks + 1 : 0;
        if (embozoTicks >= ciclosEmbozoNecesarios && !clogFlag) {
          clogFlag = true;
          embozosNuevos.push({ id: s.id, name: s.name, flowMeasured: sim.flowMeasured, nominalFlow });
          flowAlarmLog = [
            { ts: now.toISOString(), tipo: "embozo", flowMeasured: sim.flowMeasured, nominalFlow, porcentaje: porcentajeActual },
            ...flowAlarmLog,
          ].slice(0, 100);
        } else if (!esEmbozo) {
          clogFlag = false;
        }
      } else {
        // Si la línea no está activa (o la presión no es fiable), se
        // reinician los contadores de "tiempo sostenido" — si no, una racha
        // vieja de ciclos casi completa se arrastraba a la siguiente vez que
        // se abre la válvula y disparaba el aviso mucho antes de lo debido.
        fugaLeveTicks = 0;
        embozoTicks = 0;
      }

      let blockedByFault = s.blockedByFault || false;
      // Con datos reales, el caudal viene de lecturas_sensores, que solo
      // actualiza el worker cada 5 min — hace falta bastante más margen que
      // en la simulación (que refleja el caudal al instante) antes de dar
      // por hecho que "caudal 0" es un fallo real y no simplemente una
      // lectura todavía no actualizada tras abrir la válvula.
      const ciclosFalloElectricoNecesarios = s.lineaBackendId ? 28 : 2; // ~7 min con datos reales, ~30 s en la simulación
      const falloElectricoActivoAqui = alarmasInstalacion?.fallo_electrico !== false;
      if (falloElectricoActivoAqui && active && nominalFlow > 0 && presionEnRangoTrabajo && sim.flowMeasured === 0 && !blockedByFault) {
        zeroFlowTicksRef.current[s.id] = (zeroFlowTicksRef.current[s.id] || 0) + 1;
        if (zeroFlowTicksRef.current[s.id] >= ciclosFalloElectricoNecesarios) {
          blockedByFault = true;
          fallosElectricos.push({ id: s.id, name: s.name });
        }
      } else if (!active || !presionEnRangoTrabajo) {
        zeroFlowTicksRef.current[s.id] = 0;
      }

      const prevSensors = s.sensors || {};
      const sameDay = prevSensors.lastResetDay === todayStr;
      const deltaLiters = sim.flowMeasured * (15 / 3600); // caudal L/h -> litros en 15 s

      // Litros de hoy: si Loxone nos da el dato ya calculado (Cd del contador
      // real), se usa directamente — es más fiable que integrar el caudal
      // nosotros mismos, y no depende de detectar cambios de día a mano.
      let litersToday;
      if (lecturaReal?.litrosHoy !== undefined && lecturaReal?.litrosHoy !== null) {
        litersToday = lecturaReal.litrosHoy;
      } else {
        const prevLiters = sameDay ? Number(prevSensors.litersToday || 0) : 0;
        litersToday = Math.round((prevLiters + deltaLiters) * 10) / 10;
      }

      const horaActual = now.getHours();
      const prevHourly = sameDay && Array.isArray(s.hourlyConsumption) ? s.hourlyConsumption : Array(24).fill(0);
      const hourlyConsumption = prevHourly.map((v, h) => (h === horaActual ? Math.round((v + deltaLiters) * 10) / 10 : v));

      const newSensors = { ...sim, litersToday, lastResetDay: todayStr };
      const historyPoint = { label, humidity: sim.humidity, temperature: sim.temperature, ec: sim.ec, liters: litersToday };
      const newHistory = [...(s.history || []), historyPoint].slice(-MAX_PUNTOS_GRAFICA);

      const th = s.thresholds || {};
      let humidityFlag = s.humidityFlag || false;
      const humedadFuera = alarmasInstalacion?.humedad !== false && (newSensors.humidity < th.humidityMin || newSensors.humidity > th.humidityMax);
      if (humedadFuera && !humidityFlag) {
        humidityFlag = true;
        humedadNuevos.push({ id: s.id, name: s.name, valor: newSensors.humidity, min: th.humidityMin, max: th.humidityMax });
      } else if (!humedadFuera) {
        humidityFlag = false;
      }

      let ecFlag = s.ecFlag || false;
      const ecFuera = alarmasInstalacion?.ec !== false && (newSensors.ec < th.ecMin || newSensors.ec > th.ecMax);
      if (ecFuera && !ecFlag) {
        ecFlag = true;
        ecNuevos.push({ id: s.id, name: s.name, valor: newSensors.ec, min: th.ecMin, max: th.ecMax });
      } else if (!ecFuera) {
        ecFlag = false;
      }

      let temperatureFlag = s.temperatureFlag || false;
      const tMin = th.temperatureMin ?? -99;
      const tMax = th.temperatureMax ?? 99;
      const temperaturaFuera = alarmasInstalacion?.temperatura !== false && (newSensors.temperature < tMin || newSensors.temperature > tMax);
      if (temperaturaFuera && !temperatureFlag) {
        temperatureFlag = true;
        temperaturaNuevos.push({ id: s.id, name: s.name, valor: newSensors.temperature, min: tMin, max: tMax });
      } else if (!temperaturaFuera) {
        temperatureFlag = false;
      }

      let riegoLog = s.riegoLog || [];
      if (wasActive && !active) {
        const sesion = sessionStartRef.current[s.id];
        if (sesion) {
          const duracionMin = Math.max(1, Math.round((now.getTime() - new Date(sesion.startTs).getTime()) / 60000));
          const litrosUsados = Math.max(0, Math.round((litersToday - sesion.litersAtStart) * 10) / 10);
          riegoLog = [
            {
              id: `riego-${now.getTime()}-${Math.round(Math.random() * 1000)}`,
              startTs: sesion.startTs,
              endTs: now.toISOString(),
              durationMin: duracionMin,
              liters: litrosUsados,
              tipo: sesion.tipo,
            },
            ...riegoLog,
          ].slice(0, MAX_RIEGO_LOG);
          delete sessionStartRef.current[s.id];
        }
      }

      let dailyHist = s.dailyConsumption || [];
      let hourlyHist = s.hourlyHistory || [];
      let humidityHourlyHist = s.humidityHourlyHistory || [];
      let humidityDailyHist = s.humidityDailyHistory || [];

      // Lectura REAL de humedad (no promediada): se guarda una vez por hora,
      // igual que hacemos con la presión de red.
      let temperatureHourlyHist = s.temperatureHourlyHistory || [];
      let temperatureDailyHist = s.temperatureDailyHistory || [];
      let ecHourlyHist = s.ecHourlyHistory || [];
      let ecDailyHist = s.ecDailyHistory || [];
      let caudalHourlyHist = s.flowHourlyHistory || [];
      let caudalDailyHist = s.flowDailyHistory || [];

      const horaClaveHumedad = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
      if (humedadLastHourRef.current[s.id] !== horaClaveHumedad) {
        humedadLastHourRef.current[s.id] = horaClaveHumedad;
        humidityHourlyHist = [
          ...humidityHourlyHist,
          {
            ts: now.toISOString(),
            label: now.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(now.getHours()).padStart(2, "0") + "h",
            humidity: sim.humidity,
          },
        ].slice(-MAX_LECTURAS_HUMEDAD_HORARIA);
      }
      if (tempLastHourRef.current[s.id] !== horaClaveHumedad) {
        tempLastHourRef.current[s.id] = horaClaveHumedad;
        temperatureHourlyHist = [
          ...temperatureHourlyHist,
          {
            ts: now.toISOString(),
            label: now.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(now.getHours()).padStart(2, "0") + "h",
            temperature: sim.temperature,
          },
        ].slice(-MAX_LECTURAS_SENSOR_HORARIA);
      }
      if (ecLastHourRef.current[s.id] !== horaClaveHumedad) {
        ecLastHourRef.current[s.id] = horaClaveHumedad;
        ecHourlyHist = [
          ...ecHourlyHist,
          {
            ts: now.toISOString(),
            label: now.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(now.getHours()).padStart(2, "0") + "h",
            ec: sim.ec,
          },
        ].slice(-MAX_LECTURAS_SENSOR_HORARIA);
      }
      if (caudalLastHourRef.current[s.id] !== horaClaveHumedad) {
        caudalLastHourRef.current[s.id] = horaClaveHumedad;
        caudalHourlyHist = [
          ...caudalHourlyHist,
          {
            ts: now.toISOString(),
            label: now.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(now.getHours()).padStart(2, "0") + "h",
            flow: sim.flowMeasured,
          },
        ].slice(-MAX_LECTURAS_SENSOR_HORARIA);
      }

      // Media diaria de humedad (para el historial de 1 año, a más largo plazo).
      humedadSumTodayRef.current[s.id] = (humedadSumTodayRef.current[s.id] || 0) + sim.humidity;
      humedadCountTodayRef.current[s.id] = (humedadCountTodayRef.current[s.id] || 0) + 1;
      tempSumTodayRef.current[s.id] = (tempSumTodayRef.current[s.id] || 0) + sim.temperature;
      tempCountTodayRef.current[s.id] = (tempCountTodayRef.current[s.id] || 0) + 1;
      ecSumTodayRef.current[s.id] = (ecSumTodayRef.current[s.id] || 0) + sim.ec;
      ecCountTodayRef.current[s.id] = (ecCountTodayRef.current[s.id] || 0) + 1;
      caudalSumTodayRef.current[s.id] = (caudalSumTodayRef.current[s.id] || 0) + sim.flowMeasured;
      caudalCountTodayRef.current[s.id] = (caudalCountTodayRef.current[s.id] || 0) + 1;

      if (dayChanged) {
        dailyHist = [
          ...dailyHist,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            liters: Math.round(Number(prevSensors.litersToday || 0)),
          },
        ].slice(-MAX_DIAS_HISTORICO);
        hourlyHist = [
          ...hourlyHist,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short" }),
            hours: Array.isArray(s.hourlyConsumption) ? s.hourlyConsumption : Array(24).fill(0),
          },
        ].slice(-MAX_DIAS_HORARIO);
        const sumaHumedadAnterior = humedadSumTodayRef.current[s.id] - sim.humidity;
        const cuentaHumedadAnterior = humedadCountTodayRef.current[s.id] - 1;
        const mediaHumedadAnterior =
          cuentaHumedadAnterior > 0 ? Math.round((sumaHumedadAnterior / cuentaHumedadAnterior) * 10) / 10 : sim.humidity;
        humidityDailyHist = [
          ...humidityDailyHist,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            avgHumidity: mediaHumedadAnterior,
          },
        ].slice(-MAX_DIAS_HISTORICO);
        humedadSumTodayRef.current[s.id] = sim.humidity;
        humedadCountTodayRef.current[s.id] = 1;

        const sumaTempAnterior = tempSumTodayRef.current[s.id] - sim.temperature;
        const cuentaTempAnterior = tempCountTodayRef.current[s.id] - 1;
        const mediaTempAnterior =
          cuentaTempAnterior > 0 ? Math.round((sumaTempAnterior / cuentaTempAnterior) * 10) / 10 : sim.temperature;
        temperatureDailyHist = [
          ...temperatureDailyHist,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            avgTemperature: mediaTempAnterior,
          },
        ].slice(-MAX_DIAS_HISTORICO);
        tempSumTodayRef.current[s.id] = sim.temperature;
        tempCountTodayRef.current[s.id] = 1;

        const sumaEcAnterior = ecSumTodayRef.current[s.id] - sim.ec;
        const cuentaEcAnterior = ecCountTodayRef.current[s.id] - 1;
        const mediaEcAnterior = cuentaEcAnterior > 0 ? Math.round((sumaEcAnterior / cuentaEcAnterior) * 100) / 100 : sim.ec;
        ecDailyHist = [
          ...ecDailyHist,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            avgEc: mediaEcAnterior,
          },
        ].slice(-MAX_DIAS_HISTORICO);
        ecSumTodayRef.current[s.id] = sim.ec;
        ecCountTodayRef.current[s.id] = 1;

        const sumaCaudalAnterior = caudalSumTodayRef.current[s.id] - sim.flowMeasured;
        const cuentaCaudalAnterior = caudalCountTodayRef.current[s.id] - 1;
        const mediaCaudalAnterior =
          cuentaCaudalAnterior > 0 ? Math.round((sumaCaudalAnterior / cuentaCaudalAnterior) * 10) / 10 : sim.flowMeasured;
        caudalDailyHist = [
          ...caudalDailyHist,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            avgFlow: mediaCaudalAnterior,
          },
        ].slice(-MAX_DIAS_HISTORICO);
        caudalSumTodayRef.current[s.id] = sim.flowMeasured;
        caudalCountTodayRef.current[s.id] = 1;
      }

      return {
        ...s,
        sensors: newSensors,
        hourlyConsumption,
        history: newHistory,
        dailyConsumption: dailyHist,
        hourlyHistory: hourlyHist,
        humidityHourlyHistory: humidityHourlyHist,
        humidityDailyHistory: humidityDailyHist,
        temperatureHourlyHistory: temperatureHourlyHist,
        temperatureDailyHistory: temperatureDailyHist,
        ecHourlyHistory: ecHourlyHist,
        ecDailyHistory: ecDailyHist,
        flowHourlyHistory: caudalHourlyHist,
        flowDailyHistory: caudalDailyHist,
        flowAlarmLog,
        blockedByLeak,
        blockedByFault,
        minorLeakFlag,
        clogFlag,
        fugaLeveTicks,
        embozoTicks,
        humidityFlag,
        ecFlag,
        temperatureFlag,
        manualOverride,
        riegoLog,
      };
    });

    prevActiveRef.current = nextActive;
    setSectors(updated);

    // Cierre real de las electroválvulas cuyo riego manual acaba de agotar
    // su tiempo — sin await aquí (no se puede bloquear este tick, que ya
    // sigue calculando presión/caudal/alarmas justo debajo); cada cierre se
    // resuelve por su cuenta y, si falla, queda registrado en el historial
    // de eventos para que no pase desapercibido.
    riegoManualExpirado.forEach(({ nombre, lineaBackendId }) => {
      cerrarRiegoManual(lineaBackendId).then((resultado) => {
        if (!resultado.ok) {
          setHistory((h) =>
            [{ ts: new Date().toISOString(), text: `${nombre}: FALLO al cerrar el riego manual (${resultado.error})` }, ...h].slice(0, 20)
          );
        }
      });
    });
    // La presión de red es un único sensor físico compartido por toda la
    // instalación (antes del colector), así que cualquier línea con lectura
    // real de presión sirve como representante — todas deberían coincidir.
    const presionRealDisponible = (lecturasReales?.porPosicion || []).find(
      (l) => l.presion !== null && l.presion !== undefined
    )?.presion;
    const nuevaPresion =
      presionRealDisponible !== undefined
        ? Math.round(presionRealDisponible * 100) / 100
        : clamp(Math.round((2.6 - anyActiveCount * 0.06 + (Math.random() - 0.5) * 0.08) * 100) / 100, 0.5, 4.5);
    setPressureBar(nuevaPresion);

    // Caudal medido en el caudalímetro GENERAL, antes de todas las
    // electroválvulas de línea. En condiciones normales debe coincidir con
    // lo que suman las líneas activas. Si el general marca más caudal del
    // que ninguna línea explica, es agua escapándose antes de llegar a
    // ninguna electroválvula — indicio de rotura de tubería general.
    const sumaFlowLineas = updated.reduce((sum, s) => sum + Number(s.sensors?.flowMeasured || 0), 0);
    // Simulación de fuga antes de las electroválvulas — solo se usa si esta
    // instalación no tiene contador general real asignado (demo/sin Loxone
    // todavía). Con contador real (caudalGeneralReal), el dato ya viene
    // medido de verdad, incluida cualquier fuga real antes del colector.
    let fugaAntesElectrovalvulas = 0;
    if (!caudalGeneralReal && mainSupply && Math.random() < 0.0006) {
      fugaAntesElectrovalvulas = 150 + Math.random() * 350;
    }
    // Instalaciones con varios contadores (ver contadoresGenerales): el
    // caudal "real" de toda la instalación es la SUMA de los contadores de
    // verdad, no el cálculo por líneas — puede haber riego simultáneo en
    // líneas de grupos distintos (ej. línea 4 y línea 6 a la vez, cada una
    // con su propio contador), y el dato real siempre manda sobre el
    // calculado, igual que ya hacíamos con el contador único.
    const sumaContadoresGenerales =
      contadoresGenerales.length > 0
        ? contadoresGenerales.reduce((sum, c) => sum + (c.caudal != null ? Number(c.caudal) : 0), 0)
        : null;
    const caudalGeneralAhora =
      sumaContadoresGenerales !== null
        ? Math.round(sumaContadoresGenerales * 10) / 10
        : caudalGeneralReal && caudalGeneralReal.caudal !== null
        ? Number(caudalGeneralReal.caudal)
        : Math.round((sumaFlowLineas + fugaAntesElectrovalvulas) * 10) / 10;
    setCaudalGeneralMedido(caudalGeneralAhora);

    const caudalNoExplicado = Math.round((caudalGeneralAhora - sumaFlowLineas) * 10) / 10;
    const ciclosRoturaNecesarios = Math.max(1, Math.round((roturaColectorHorasSostenidas * 3600) / 15));
    const maestraActivaAqui = alarmasInstalacion?.maestra !== false;
    if (maestraActivaAqui && caudalNoExplicado > roturaColectorLitrosHora) {
      roturaColectorTicksRef.current += 1;
    } else {
      roturaColectorTicksRef.current = 0;
    }
    if (maestraActivaAqui && !maestraCerrada && roturaColectorTicksRef.current >= ciclosRoturaNecesarios) {
      const motivoTexto = `El caudalímetro general marca ${caudalNoExplicado} L/h que ninguna línea explica — indicio de rotura de tubería antes de las electroválvulas.`;
      setMaestraCerrada({ motivo: motivoTexto, ts: now.toISOString() });
      setAlarmHistory((prev) =>
        [
          {
            id: `alarm-maestra-${now.getTime()}`,
            ts: now.toISOString(),
            lineId: null,
            lineName: "Sistema general",
            type: "rotura_antes_electrovalvulas",
            detalle: motivoTexto,
          },
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
    }

    // Riego excesivo: solo aplica a instalaciones con varios contadores
    // generales (ver contadoresGenerales) que además tengan sonda de
    // escorrentía — el resto de instalaciones tiene contadoresGenerales
    // vacío y este bloque no hace nada.
    if (alarmasInstalacion?.riego_excesivo !== false) {
      contadoresGenerales.forEach((c) => {
        const humedadFuera = c.humedad_escorrentia != null && c.humedad_escorrentia > (c.umbral_escorrentia_humedad_max ?? 70);
        if (humedadFuera && !riegoExcesivoAlertadoRef.current[c.id]) {
          riegoExcesivoAlertadoRef.current[c.id] = true;
          const detalleTexto = `La escorrentía de "${c.nombre}" marca ${c.humedad_escorrentia}% de humedad, por encima del umbral (${c.umbral_escorrentia_humedad_max ?? 70}%) — indicio de riego excesivo en sus líneas.`;
          setAlarmHistory((prev) =>
            [
              {
                id: `alarm-riego-excesivo-${c.id}-${now.getTime()}`,
                ts: now.toISOString(),
                lineId: null,
                lineName: c.nombre,
                type: "riego_excesivo",
                detalle: detalleTexto,
                value: c.humedad_escorrentia,
              },
              ...prev,
            ].slice(0, MAX_ALARM_LOG)
          );
        } else if (!humedadFuera) {
          riegoExcesivoAlertadoRef.current[c.id] = false;
        }
      });
    }

    // Histórico horario REAL (no promediado): se guarda la lectura tal cual en
    // cuanto cambia la hora del reloj, una sola vez por hora, durante 14 días.
    const horaClave = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (pressureLastHourRef.current !== horaClave) {
      pressureLastHourRef.current = horaClave;
      setPressureHourlyHistory((prev) =>
        [
          ...prev,
          {
            ts: now.toISOString(),
            label: now.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) + " " + String(now.getHours()).padStart(2, "0") + "h",
            pressure: nuevaPresion,
          },
        ].slice(-MAX_LECTURAS_PRESION_HORARIA)
      );
    }

    pressureSumTodayRef.current += nuevaPresion;
    pressureCountTodayRef.current += 1;
    if (dayChanged) {
      const mediaAnterior =
        pressureCountTodayRef.current > 1
          ? Math.round(((pressureSumTodayRef.current - nuevaPresion) / (pressureCountTodayRef.current - 1)) * 100) / 100
          : nuevaPresion;
      setPressureDailyHistory((prev) =>
        [
          ...prev,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            avgPressure: mediaAnterior,
          },
        ].slice(-MAX_DIAS_HISTORICO)
      );
      pressureSumTodayRef.current = nuevaPresion;
      pressureCountTodayRef.current = 1;
    }

    // Registro de "horas sin presión": se anota el momento exacto (fecha + hora)
    // en que la presión cae por debajo del umbral de "sin agua" configurado en
    // Ajustes, una sola vez por caída (no se repite mientras se mantenga baja).
    if (nuevaPresion < presionSinAgua) {
      if (!pressureOutageActiveRef.current) {
        pressureOutageActiveRef.current = true;
        setPressureOutageLog((prev) => [{ ts: now.toISOString(), value: nuevaPresion }, ...prev].slice(0, 200));
      }
    } else {
      pressureOutageActiveRef.current = false;
    }

    let eventosCombinados = newEvents;
    if (leaksDetectados.length > 0) {
      setLeakAlerts((prev) => [
        ...prev,
        ...leaksDetectados.map((f) => ({
          lineId: f.id,
          lineName: f.name,
          ts: now.toISOString(),
          flowMeasured: f.flowMeasured,
          nominalFlow: f.nominalFlow,
        })),
      ]);
      setAlarmHistory((prev) =>
        [
          ...leaksDetectados.map((f) => ({
            id: `alarm-${now.getTime()}-${f.id}`,
            ts: now.toISOString(),
            lineId: f.id,
            lineName: f.name,
            type: "fuga_grave",
            flowMeasured: f.flowMeasured,
            nominalFlow: f.nominalFlow,
          })),
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
      eventosCombinados = [
        ...newEvents,
        ...leaksDetectados.map((f) => ({
          ts: now.toISOString(),
          text: `ALERTA: fuga grave detectada en ${f.name} (${f.flowMeasured} L/h, esperado ${f.nominalFlow} L/h) — electroválvula de la línea aislada automáticamente. El resto de líneas sigue regando con normalidad.`,
        })),
      ];
    }

    if (fugasLeves.length > 0) {
      setAlarmHistory((prev) =>
        [
          ...fugasLeves.map((f) => ({
            id: `alarm-${now.getTime()}-leve-${f.id}`,
            ts: now.toISOString(),
            lineId: f.id,
            lineName: f.name,
            type: "fuga_leve",
            flowMeasured: f.flowMeasured,
            nominalFlow: f.nominalFlow,
          })),
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
      eventosCombinados = [
        ...eventosCombinados,
        ...fugasLeves.map((f) => ({
          ts: now.toISOString(),
          text: `Aviso: posible goteo en ${f.name} (${f.flowMeasured} L/h, esperado ${f.nominalFlow} L/h) — sin aislar, revisar en próxima visita.`,
        })),
      ];
    }

    if (fallosElectricos.length > 0) {
      setAlarmHistory((prev) =>
        [
          ...fallosElectricos.map((f) => ({
            id: `alarm-${now.getTime()}-fault-${f.id}`,
            ts: now.toISOString(),
            lineId: f.id,
            lineName: f.name,
            type: "fallo_electrico",
          })),
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
      eventosCombinados = [
        ...eventosCombinados,
        ...fallosElectricos.map((f) => ({
          ts: now.toISOString(),
          text: `ALERTA: ${f.name} no responde (caudal 0 estando programada) — posible fallo eléctrico de la electroválvula, línea aislada.`,
        })),
      ];
    }

    if (embozosNuevos.length > 0) {
      setAlarmHistory((prev) =>
        [
          ...embozosNuevos.map((f) => ({
            id: `alarm-${now.getTime()}-embozo-${f.id}`,
            ts: now.toISOString(),
            lineId: f.id,
            lineName: f.name,
            type: "embozo",
            flowMeasured: f.flowMeasured,
            nominalFlow: f.nominalFlow,
          })),
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
    }

    if (humedadNuevos.length > 0) {
      setAlarmHistory((prev) =>
        [
          ...humedadNuevos.map((f) => ({
            id: `alarm-${now.getTime()}-hum-${f.id}`,
            ts: now.toISOString(),
            lineId: f.id,
            lineName: f.name,
            type: "humedad_fuera_rango",
            valor: f.valor,
            min: f.min,
            max: f.max,
          })),
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
    }

    if (ecNuevos.length > 0) {
      setAlarmHistory((prev) =>
        [
          ...ecNuevos.map((f) => ({
            id: `alarm-${now.getTime()}-ec-${f.id}`,
            ts: now.toISOString(),
            lineId: f.id,
            lineName: f.name,
            type: "ec_fuera_rango",
            valor: f.valor,
            min: f.min,
            max: f.max,
          })),
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
    }

    if (temperaturaNuevos.length > 0) {
      setAlarmHistory((prev) =>
        [
          ...temperaturaNuevos.map((f) => ({
            id: `alarm-${now.getTime()}-temp-${f.id}`,
            ts: now.toISOString(),
            lineId: f.id,
            lineName: f.name,
            type: "temperatura_fuera_rango",
            valor: f.valor,
            min: f.min,
            max: f.max,
          })),
          ...prev,
        ].slice(0, MAX_ALARM_LOG)
      );
    }

    // Alerta de "varias líneas con incidencias a la vez": si se supera el
    // umbral configurado de líneas con problema simultáneo, de forma
    // sostenida durante las horas configuradas, sospechar de una causa
    // común (presión, filtro, suministro) antes que de averías
    // independientes.
    const multiplesLineasActivoAqui = alarmasInstalacion?.multiples_lineas !== false;
    const lineasConProblema = updated.filter(
      (s) => s.blockedByLeak || s.blockedByFault || s.minorLeakFlag || s.clogFlag || s.humidityFlag || s.ecFlag || s.temperatureFlag
    );
    const ciclosMultiNecesarios = Math.max(1, Math.round((multiplesLineasHorasSostenidas * 3600) / 15));
    if (multiplesLineasActivoAqui && lineasConProblema.length >= multiplesLineasUmbral) {
      multiLineTicksRef.current += 1;
    } else {
      multiLineTicksRef.current = 0;
    }
    if (multiplesLineasActivoAqui && multiLineTicksRef.current >= ciclosMultiNecesarios && !multiLineAlert) {
      const nuevaAlertaMulti = {
        id: `alarm-${now.getTime()}-multi`,
        ts: now.toISOString(),
        lineName: `Varias líneas (${lineasConProblema.length})`,
        type: "multiples_lineas",
        cantidad: lineasConProblema.length,
        lineas: lineasConProblema.map((s) => s.name).join(", "),
      };
      setMultiLineAlert(nuevaAlertaMulti);
      setAlarmHistory((prev) => [nuevaAlertaMulti, ...prev].slice(0, MAX_ALARM_LOG));
      setHistory((h) =>
        [
          {
            ts: now.toISOString(),
            text: `ALERTA: ${lineasConProblema.length} líneas con incidencias a la vez (${nuevaAlertaMulti.lineas}) — revisar causa común antes que línea por línea.`,
          },
          ...h,
        ].slice(0, 20)
      );
    } else if (lineasConProblema.length < multiplesLineasUmbral && multiLineAlert) {
      setMultiLineAlert(null);
    }

    if (eventosCombinados.length > 0) {
      setHistory((h) => [...eventosCombinados.reverse(), ...h].slice(0, 20));
    }

    // Cada zona de presión se vigila por separado, con su propio contador de
    // ciclos y sus propias horas configuradas — "sin agua" puede avisar
    // mucho antes que una simple presión baja o alta.
    const sinAguaActivaAqui = alarmasInstalacion?.sin_agua !== false;
    const presionActivaAqui = alarmasInstalacion?.presion !== false;
    const enZonaSinAgua = sinAguaActivaAqui && nuevaPresion < presionSinAgua;
    const enZonaBaja = presionActivaAqui && !enZonaSinAgua && nuevaPresion < presionBaja;
    const enZonaAlta = presionActivaAqui && nuevaPresion > presionAlta;

    pressureSinAguaTicksRef.current = enZonaSinAgua ? pressureSinAguaTicksRef.current + 1 : 0;
    pressureBajaTicksRef.current = enZonaBaja ? pressureBajaTicksRef.current + 1 : 0;
    pressureAltaTicksRef.current = enZonaAlta ? pressureAltaTicksRef.current + 1 : 0;

    // El reloj de simulación se actualiza cada 15 segundos, así que
    // convertimos las horas configuradas de cada zona a número de ciclos.
    const ciclosSinAguaNecesarios = Math.max(1, Math.round((presionHorasSinAgua * 3600) / 15));
    const ciclosBajaNecesarios = Math.max(1, Math.round((presionHorasBaja * 3600) / 15));
    const ciclosAltaNecesarios = Math.max(1, Math.round((presionHorasAlta * 3600) / 15));

    if (!pressureAlert) {
      let tipo = null;
      let horasUsadas = null;
      if (pressureSinAguaTicksRef.current >= ciclosSinAguaNecesarios) {
        tipo = "sin_agua_red";
        horasUsadas = presionHorasSinAgua;
      } else if (pressureBajaTicksRef.current >= ciclosBajaNecesarios) {
        tipo = "presion_baja";
        horasUsadas = presionHorasBaja;
      } else if (pressureAltaTicksRef.current >= ciclosAltaNecesarios) {
        tipo = "presion_alta";
        horasUsadas = presionHorasAlta;
      }
      if (tipo) {
        const nuevaAlerta = {
          id: `alarm-${now.getTime()}-presion`,
          ts: now.toISOString(),
          lineName: "Red / suministro general",
          type: tipo,
          value: nuevaPresion,
          umbralSinAgua: presionSinAgua,
          umbralBaja: presionBaja,
          umbralAlta: presionAlta,
        };
        setPressureAlert(nuevaAlerta);
        setAlarmHistory((prev) => [nuevaAlerta, ...prev].slice(0, MAX_ALARM_LOG));
        setHistory((h) =>
          [
            {
              ts: now.toISOString(),
              text: `ALERTA: presión de red sostenidamente ${
                tipo === "sin_agua_red" ? "sin agua" : tipo === "presion_baja" ? "baja" : "alta"
              } (${nuevaPresion} bar durante ≥${horasUsadas} h).`,
            },
            ...h,
          ].slice(0, 20)
        );
      }
    }

    const totalFlow = sumaFlowLineas;
    setFlowHistory((h) => [...h, { label, value: totalFlow }].slice(-MAX_PUNTOS_GRAFICA));
    setPressureHistory((h) => [...h, { label, value: nuevaPresion }].slice(-MAX_PUNTOS_GRAFICA));

    // Consumo del depósito de fertilizante: proporcional al agua dosificada,
    // según la dosis y el tamaño de depósito configurados en Ajustes.
    const TANQUE_ML = Math.max(1, Number(fertilizerTanqueL) || 20) * 1000;
    const DOSIS_ML_POR_LITRO = Number(fertilizerDosisMlPorLitro) || 0;
    const litrosEsteTick = totalFlow * (15 / 3600);
    const consumoML = litrosEsteTick * DOSIS_ML_POR_LITRO;
    const nuevoNivel = clamp(Math.round((fertilizerLevel - (consumoML / TANQUE_ML) * 100) * 10) / 10, 0, 100);
    setFertilizerLevel(nuevoNivel);

    if (dayChanged) {
      setFertilizerDailyHistory((prev) =>
        [
          ...prev,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }),
            consumoML: Math.round(fertilizerConsumedToday),
          },
        ].slice(-MAX_DIAS_HISTORICO)
      );
      setFertilizerHourlyHistory((prev) =>
        [
          ...prev,
          {
            date: fechaAnterior,
            label: new Date(fechaAnterior).toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short" }),
            hours: Array.isArray(fertilizerHourlyConsumption) ? fertilizerHourlyConsumption : Array(24).fill(0),
          },
        ].slice(-MAX_DIAS_HORARIO)
      );
      setFertilizerConsumedToday(Math.round(consumoML * 10) / 10);
      setFertilizerHourlyConsumption(
        Array(24)
          .fill(0)
          .map((v, h) => (h === now.getHours() ? Math.round(consumoML * 10) / 10 : 0))
      );
    } else {
      setFertilizerConsumedToday((prev) => Math.round((prev + consumoML) * 10) / 10);
      setFertilizerHourlyConsumption((prev) => {
        const base = Array.isArray(prev) ? prev : Array(24).fill(0);
        const horaActualFert = now.getHours();
        return base.map((v, h) => (h === horaActualFert ? Math.round((v + consumoML) * 10) / 10 : v));
      });
    }

    // La alarma de fertilizante solo salta si el nivel se mantiene por
    // debajo del umbral de forma continuada, durante las horas configuradas
    // (no ante una lectura puntual, p.ej. justo tras una tanda larga).
    const ciclosFertNecesarios = Math.max(1, Math.round((fertilizanteHorasSostenidas * 3600) / 15));
    const fertilizanteActivoAqui = alarmasInstalacion?.fertilizante !== false;
    if (fertilizanteActivoAqui && nuevoNivel < fertilizanteUmbralAgotado) {
      fertilizerAgotadoTicksRef.current += 1;
    } else {
      fertilizerAgotadoTicksRef.current = 0;
    }
    if (fertilizanteActivoAqui && nuevoNivel < fertilizanteUmbralBajo) {
      fertilizerBajoTicksRef.current += 1;
    } else {
      fertilizerBajoTicksRef.current = 0;
    }

    if (fertilizanteActivoAqui && fertilizerAgotadoTicksRef.current >= ciclosFertNecesarios && !fertilizerAlertedRef.current.agotado) {
      fertilizerAlertedRef.current = { bajo: true, agotado: true };
      const nuevaAlertaFert = {
        id: `alarm-${now.getTime()}-fert-agotado`,
        ts: now.toISOString(),
        lineName: "Depósito de fertilizante",
        type: "fertilizante_agotado",
        value: nuevoNivel,
        umbral: fertilizanteUmbralAgotado,
      };
      setFertilizerAlert(nuevaAlertaFert);
      setAlarmHistory((prev) => [nuevaAlertaFert, ...prev].slice(0, MAX_ALARM_LOG));
      setHistory((h) =>
        [{ ts: now.toISOString(), text: `ALERTA: depósito de fertilizante prácticamente agotado (${nuevoNivel}%).` }, ...h].slice(0, 20)
      );
    } else if (fertilizanteActivoAqui && fertilizerBajoTicksRef.current >= ciclosFertNecesarios && !fertilizerAlertedRef.current.bajo) {
      fertilizerAlertedRef.current = { ...fertilizerAlertedRef.current, bajo: true };
      const nuevaAlertaFert = {
        id: `alarm-${now.getTime()}-fert-bajo`,
        ts: now.toISOString(),
        lineName: "Depósito de fertilizante",
        type: "fertilizante_bajo",
        value: nuevoNivel,
        umbral: fertilizanteUmbralBajo,
      };
      setFertilizerAlert((prev) => prev || nuevaAlertaFert);
      setAlarmHistory((prev) => [nuevaAlertaFert, ...prev].slice(0, MAX_ALARM_LOG));
      setHistory((h) => [{ ts: now.toISOString(), text: `Aviso: nivel de fertilizante bajo (${nuevoNivel}%).` }, ...h].slice(0, 20));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, lecturasReales]);

  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmBorrarActividad, setConfirmBorrarActividad] = useState(false);
  const [confirmProgramarAuto, setConfirmProgramarAuto] = useState(false);
  const [confirmBorrarHistorialRed, setConfirmBorrarHistorialRed] = useState(false);
  const [confirmMantenimientoRealizado, setConfirmMantenimientoRealizado] = useState(false);
  const [showCalendarioMantenimiento, setShowCalendarioMantenimiento] = useState(false);
  // Coordenadas del puntero (ratón o dedo) relativas al lienzo de firma.
  // Funciones "factoría" de firma: reciben el lienzo (canvas) y la
  // referencia de "estoy dibujando" correspondientes, y devuelven los
  // manejadores ya enganchados a ese lienzo — así la misma lógica sirve
  // tanto para la firma del técnico como para la del cliente, sin duplicar
  // el código de dibujo dos veces.
  const posicionFirmaEn = (canvasRef, e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  };
  const crearManejadoresFirma = (canvasRef, dibujandoRef, setDataUrl, setFecha) => ({
    empezarTrazo: (e) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const { x, y } = posicionFirmaEn(canvasRef, e);
      dibujandoRef.current = true;
      ctx.beginPath();
      ctx.moveTo(x, y);
    },
    continuarTrazo: (e) => {
      if (!dibujandoRef.current) return;
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const { x, y } = posicionFirmaEn(canvasRef, e);
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineTo(x, y);
      ctx.stroke();
    },
    terminarTrazo: () => {
      dibujandoRef.current = false;
    },
    borrar: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },
    guardar: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      setDataUrl(canvas.toDataURL("image/png"));
      setFecha(new Date().toISOString());
    },
  });
  const firmaTecnico = crearManejadoresFirma(firmaCanvasRef, firmaDibujandoRef, setFirmaDataUrl, setFirmaFecha);
  const firmaCliente = crearManejadoresFirma(
    firmaClienteCanvasRef,
    firmaClienteDibujandoRef,
    setFirmaClienteDataUrl,
    setFirmaClienteFecha
  );

  // Pone el historial de alarmas y los avisos activos a cero para volver a
  // evaluarlos desde ahora, con la instalación real en marcha — no toca
  // líneas, ajustes ni históricos reales (los datos de ejemplo ya no se
  // usan una vez la instalación está conectada de verdad).
  const reiniciarPanel = () => {
    setAlarmHistory([]);
    setLeakAlerts([]);
    setPressureAlert(null);
    setMultiLineAlert(null);
    setFertilizerAlert(null);
    setConfirmReset(false);
    pressureSinAguaTicksRef.current = 0;
    pressureBajaTicksRef.current = 0;
    pressureAltaTicksRef.current = 0;
    multiLineTicksRef.current = 0;
    fertilizerBajoTicksRef.current = 0;
    fertilizerAgotadoTicksRef.current = 0;
    fertilizerAlertedRef.current = { bajo: false, agotado: false };
    roturaColectorTicksRef.current = 0;
    zeroFlowTicksRef.current = {};
  };

  // Borra solo el registro de actividad (riegos, cambios, rearmes...) —
  // independiente del historial de alarmas.
  const borrarActividad = () => {
    setHistory([]);
    setConfirmBorrarActividad(false);
  };

  // Al desactivar un tipo de alarma en "Alarmas activas" (Configuración),
  // no basta con dejar de generar avisos nuevos: si ya había uno activo
  // (incluso restaurado de una sesión anterior, guardado en localStorage
  // antes de desactivarlo), tiene que desaparecer también, o seguiría
  // mostrándose sin que el técnico pueda hacer nada al respecto.
  useEffect(() => {
    if (!alarmasInstalacion) return;
    if (pressureAlert) {
      const categoria = categoriaDeAlarma(pressureAlert.type);
      if (
        (categoria === "presion" && alarmasInstalacion.presion === false) ||
        (categoria === "sin_agua" && alarmasInstalacion.sin_agua === false)
      ) {
        setPressureAlert(null);
      }
    }
    if (multiLineAlert && alarmasInstalacion.multiples_lineas === false) {
      setMultiLineAlert(null);
    }
    if (fertilizerAlert && alarmasInstalacion.fertilizante === false) {
      setFertilizerAlert(null);
    }
    if (maestraCerrada && alarmasInstalacion.maestra === false) {
      setMaestraCerrada(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alarmasInstalacion]);

  const barraAscii = (valor, maximo, ancho = 18) => {
    if (!maximo || maximo <= 0) return "░".repeat(ancho);
    const llenas = Math.max(0, Math.min(ancho, Math.round((valor / maximo) * ancho)));
    return "█".repeat(llenas) + "░".repeat(ancho - llenas);
  };

  // Construye el texto del informe de mantenimiento (mismo contenido tanto
  // para el email como para WhatsApp) — separado del propio envío, para no
  // repetir la lógica dos veces.
  const construirTextoInformeMantenimiento = () => {
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString("es-ES", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    const mesActual = ahora.getMonth();
    const anioActual = ahora.getFullYear();
    const nombreMes = ahora.toLocaleDateString("es-ES", { month: "long" });
    const lineasActivas = sectors.filter(
      (s) => isSectorActiveNow(s, now) || Number(s.sensors?.flowMeasured || 0) > 0
    ).length;
    const alarmasAbiertas = alarmHistory
      .filter((a) => a.type !== "fuga_rearmada" && a.type !== "fallo_electrico_resuelto")
      .slice(0, 10);
    const lineasBloqueadas = sectors.filter((s) => s.blockedByLeak || s.blockedByFault);

    // Consumo de este mes, por línea (suma de los días del histórico diario que
    // caen en el mes en curso, más lo que lleve hoy).
    const consumoPorLinea = sectors.map((s) => {
      const diasDelMes = (s.dailyConsumption || []).filter((d) => {
        const fd = new Date(d.date);
        return fd.getMonth() === mesActual && fd.getFullYear() === anioActual;
      });
      const totalDias = diasDelMes.reduce((sum, d) => sum + Number(d.liters || 0), 0);
      const total = Math.round((totalDias + Number(s.sensors?.litersToday || 0)) * 10) / 10;
      return { nombre: s.name, litros: total };
    });
    const totalConsumoMes = Math.round(consumoPorLinea.reduce((sum, l) => sum + l.litros, 0) * 10) / 10;

    // Fertilizante: consumo del mes y última fecha de relleno.
    const fertilizanteMes = (fertilizerDailyHistory || []).filter((d) => {
      const fd = new Date(d.date);
      return fd.getMonth() === mesActual && fd.getFullYear() === anioActual;
    });
    const totalFertilizanteMes = Math.round(
      (fertilizanteMes.reduce((sum, d) => sum + Number(d.consumoML || 0), 0) + Number(fertilizerConsumedToday || 0)) * 10
    ) / 10;
    const ultimoRelleno = alarmHistory.find((a) => a.type === "fertilizante_rellenado");

    // Checklist de procesos realizados en esta visita — solo se menciona lo
    // que SÍ se ha hecho, con una explicación real de en qué consiste cada
    // trabajo (no solo la etiqueta corta del checklist interno).
    const procesosHechos = CATALOGO_PROCESOS_MANTENIMIENTO.filter((p) => procesosRealizados[p.key]);

    const maxConsumoLinea = Math.max(1, ...consumoPorLinea.map((l) => l.litros));
    const nombreMaxLargo = Math.max(8, ...consumoPorLinea.map((l) => l.nombre.length));

    const SEP = "─".repeat(32);

    const frecuenciaLabel = {
      mensual: "mensual",
      bimensual: "bimensual (cada 2 meses)",
      trimestral: "trimestral (cada 3 meses)",
      cuatrimestral: "cuatrimestral (cada 4 meses)",
      semestral: "semestral (cada 6 meses)",
    }[cliente.frecuenciaMantenimiento];

    const subject = `🌿 Verdtical · Informe de mantenimiento — ${fecha}`;
    const bodyLineas = [
      "🌿 VERDTICAL ECOSISTEMA — INFORME DE MANTENIMIENTO",
      SEP,
      "",
      `Estimado/a ${cliente.nombre || "cliente"},`,
      "",
      "Le enviamos el resumen de la visita de mantenimiento realizada en su instalación de riego, junto con el estado actual del sistema.",
      "",
      SEP,
      "📋 TRABAJOS REALIZADOS EN ESTA VISITA",
      SEP,
      ...(procesosHechos.length
        ? procesosHechos.flatMap((p) => [`✓ ${p.label}`, `  ${p.detalle}`, ""])
        : ["No se han registrado trabajos específicos en esta visita.", ""]),
      notaObservacion ? "📝 Observaciones del técnico:" : "",
      notaObservacion ? `  ${notaObservacion}` : "",
      notaObservacion ? "" : "",
      SEP,
      "💧 ESTADO ACTUAL DE LA INSTALACIÓN",
      SEP,
      `Líneas de riego totales: ${sectors.length}`,
      `Líneas regando en este momento: ${lineasActivas}`,
      `Presión de red: ${pressureBar} bar`,
      lineasBloqueadas.length
        ? `⚠ Incidencia abierta ahora mismo en: ${lineasBloqueadas.map((s) => s.name).join(", ")}`
        : "✓ Sin incidencias abiertas en este momento.",
      "",
      SEP,
      `💦 CONSUMO DE AGUA — ${nombreMes.toUpperCase()}`,
      SEP,
      ...consumoPorLinea.map(
        (l) => `  ${l.nombre.padEnd(nombreMaxLargo)}  ${barraAscii(l.litros, maxConsumoLinea)}  ${l.litros} L`
      ),
      `  ${"".padEnd(nombreMaxLargo)}  ${"—".repeat(18)}`,
      `  ${"Total".padEnd(nombreMaxLargo)}  ${totalConsumoMes} L`,
      "",
      SEP,
      "🧪 DEPÓSITO DE FERTILIZANTE",
      SEP,
      `  Nivel actual     [${barraAscii(fertilizerLevel, 100)}] ${fertilizerLevel}%`,
      `  Consumo ${nombreMes.padEnd(9)} [${barraAscii(totalFertilizanteMes, Math.max(totalFertilizanteMes, 5000))}] ${totalFertilizanteMes} mL`,
      ultimoRelleno
        ? `  Último relleno: ${new Date(ultimoRelleno.ts).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })}`
        : "  Sin relleno registrado todavía.",
      "",
      cliente.proximoMantenimiento ? SEP : "",
      cliente.proximoMantenimiento ? "📅 PRÓXIMA VISITA DE MANTENIMIENTO" : "",
      cliente.proximoMantenimiento ? SEP : "",
      cliente.proximoMantenimiento
        ? `Su próxima visita de mantenimiento está programada para el ${new Date(cliente.proximoMantenimiento).toLocaleDateString("es-ES", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}${frecuenciaLabel ? ` (frecuencia ${frecuenciaLabel})` : ""}.`
        : "",
      cliente.proximoMantenimiento ? "" : "",
      alarmasAbiertas.length ? SEP : "",
      alarmasAbiertas.length ? "🔔 HISTORIAL DE AVISOS RECIENTES" : "",
      alarmasAbiertas.length ? SEP : "",
      ...alarmasAbiertas.map((a) => {
        const t = textoAlarma(a);
        return `  · ${a.lineName || "Sistema"} — ${t.titulo} (${new Date(a.ts).toLocaleDateString("es-ES", { day: "2-digit", month: "short" })})`;
      }),
      "",
      "Quedamos a su disposición para cualquier consulta.",
      "",
      "Un saludo,",
      "Equipo Verdtical Ecosistema",
    ].filter((l) => l !== "");
    return { subject, body: bodyLineas.join("\n") };
  };

  const enviarInformeMantenimientoCliente = () => {
    if (!cliente.email) return null;
    const { subject, body } = construirTextoInformeMantenimiento();
    const destino = cliente.emailAvisos || cliente.email;
    return `mailto:${encodeURIComponent(destino)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const enviarInformeMantenimientoWhatsapp = () => {
    if (!cliente.telefono) return null;
    const { subject, body } = construirTextoInformeMantenimiento();
    const telefono = cliente.telefono.replace(/[^0-9]/g, "");
    return `https://wa.me/${telefono}?text=${encodeURIComponent(`${subject}\n\n${body}`)}`;
  };

  const rellenarFertilizante = () => {
    setFertilizerLevel(100);
    setFertilizerAlert(null);
    fertilizerAlertedRef.current = { bajo: false, agotado: false };
    setAlarmHistory((prev) =>
      [
        {
          id: `alarm-${Date.now()}-fert-relleno`,
          ts: new Date().toISOString(),
          lineName: "Depósito de fertilizante",
          type: "fertilizante_rellenado",
        },
        ...prev,
      ].slice(0, MAX_ALARM_LOG)
    );
    setHistory((h) => [{ ts: new Date().toISOString(), text: "Depósito de fertilizante marcado como rellenado (100%)." }, ...h].slice(0, 20));
  };

  const rearmarLineaFault = (lineId, lineName) => {
    setSectors((prev) => prev.map((s) => (s.id === lineId ? { ...s, blockedByFault: false } : s)));
    setAlarmHistory((prev) =>
      [
        { id: `alarm-${Date.now()}`, ts: new Date().toISOString(), lineId, lineName, type: "fallo_electrico_resuelto" },
        ...prev,
      ].slice(0, MAX_ALARM_LOG)
    );
    setHistory((h) => [{ ts: new Date().toISOString(), text: `${lineName}: electroválvula rearmada tras fallo eléctrico` }, ...h].slice(0, 20));
  };

  const descartarAlertaPresion = () => {
    setPressureAlert(null);
    pressureSinAguaTicksRef.current = 0;
    pressureBajaTicksRef.current = 0;
    pressureAltaTicksRef.current = 0;
  };

  const descartarAlertaMultiLinea = () => {
    setMultiLineAlert(null);
  };

  const rearmarLinea = (lineId, lineName) => {
    setSectors((prev) => prev.map((s) => (s.id === lineId ? { ...s, blockedByLeak: false } : s)));
    setLeakAlerts((prev) => prev.filter((a) => a.lineId !== lineId));
    setAlarmHistory((prev) =>
      [
        { id: `alarm-${Date.now()}`, ts: new Date().toISOString(), lineId, lineName, type: "fuga_rearmada" },
        ...prev,
      ].slice(0, MAX_ALARM_LOG)
    );
    setHistory((h) => [{ ts: new Date().toISOString(), text: `${lineName}: electroválvula rearmada manualmente` }, ...h].slice(0, 20));
  };

  const updateSector = (id, updated) => {
    setSectors((prev) => prev.map((s) => (s.id === id ? updated : s)));
  };

  const [guardandoConfigLinea, setGuardandoConfigLinea] = useState(null);
  const [avisoGuardarConfigLinea, setAvisoGuardarConfigLinea] = useState(null);

  // Manda superficie/exposición/difusores/caudal al backend — hasta ahora
  // estos campos solo se guardaban en el navegador (ver guardarLineaBackend
  // en apiClient.js), así que se perdían para siempre con solo borrar los
  // datos del sitio. Solo tiene sentido si la línea ya está emparejada con
  // el backend (instalación con Loxone conectado).
  const guardarConfigLinea = async (s) => {
    if (!s.lineaBackendId) return;
    setGuardandoConfigLinea(s.id);
    setAvisoGuardarConfigLinea(null);
    const th = s.thresholds || {};
    const resultado = await guardarLineaBackend(s.lineaBackendId, {
      superficie_m2: s.areaM2 ?? null,
      exposicion: s.exposicion || null,
      num_difusores: s.emitters ?? null,
      caudal_difusor_lh: s.emitterFlow ?? null,
      umbral_humedad_min: th.humidityMin ?? null,
      umbral_humedad_max: th.humidityMax ?? null,
      umbral_ec_min: th.ecMin ?? null,
      umbral_ec_max: th.ecMax ?? null,
      umbral_temperatura_min: th.temperatureMin ?? null,
      umbral_temperatura_max: th.temperatureMax ?? null,
      umbral_caudal_min_pct: th.flowMinPercent ?? null,
      umbral_caudal_max_pct: th.flowMaxPercent ?? null,
    });
    setGuardandoConfigLinea(null);
    setAvisoGuardarConfigLinea({
      id: s.id,
      ok: resultado.ok,
      mensaje: resultado.ok ? "guardado en el servidor ✓" : `no se pudo guardar: ${resultado.error}`,
    });
  };

  // DESACTIVADO: un guardado automático silencioso resultó demasiado
  // peligroso — cualquier dispositivo con datos locales viejos (de antes de
  // que Cubierta Galileo tuviera su configuración real) los volvía a mandar
  // al servidor solo con abrir el panel, sin que nadie tocara nada, pisando
  // la configuración correcta cada vez. Vuelve a depender del botón manual
  // "guardar en el servidor" (guardarConfigLinea) hasta tener una versión
  // seguraque no pueda sobreescribir a ciegas con datos obsoletos.

  const guardarAlarmasInstalacion = async () => {
    setGuardandoAlarmasInstalacion(true);
    setAvisoAlarmasInstalacion(null);
    const resultado = await guardarAjustesProyecto({ alarmas_activas: alarmasInstalacion });
    setGuardandoAlarmasInstalacion(false);
    setAvisoAlarmasInstalacion(
      resultado.ok ? "guardado en el servidor ✓" : `no se pudo guardar: ${resultado.error}`
    );
  };

  const subirPlano = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Redimensionamos y comprimimos en el navegador antes de guardar,
        // para no llenar el almacenamiento con fotos a resolución completa.
        const maxAncho = 1400;
        const escala = Math.min(1, maxAncho / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * escala;
        canvas.height = img.height * escala;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setPlanoImagen(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  const colocarLineaEnPlano = (sectorId, xPct, yPct) => {
    setSectors((prev) =>
      prev.map((s) => (s.id === sectorId ? { ...s, posicionPlano: { x: xPct, y: yPct } } : s))
    );
    setLineaColocando(null);
  };

  const quitarLineaDePlano = (sectorId) => {
    setSectors((prev) => prev.map((s) => (s.id === sectorId ? { ...s, posicionPlano: null } : s)));
  };

  const [resumenProgramacionGlobal, setResumenProgramacionGlobal] = useState(null);
  const [temporadaListado, setTemporadaListado] = useState(() => getSeasonForDate(now));

  // Mientras haya alguna pantalla completa abierta (Plano, listado de
  // horarios, informe y firma), bloqueamos el desplazamiento de la página de
  // fondo, para que no aparezca un doble scroll (el de la pantalla y el de
  // detrás a la vez).
  // Al entrar en Plano, Listado de horarios o Informe y firma, cerramos
  // cualquier desplegable que se hubiera quedado abierto en la pantalla
  // anterior, para que no aparezca flotando por encima.
  useEffect(() => {
    if (pantallaActiva === "plano" || pantallaActiva === "listado" || pantallaActiva === "informe") {
      setShowTecnicoConfig(false);
      setShowClienteConfig(false);
      setShowFertilizerHistory(false);
      setShowRedHistory(false);
      setShowLitrosChart(false);
      setShowPresionChart(false);
      setShowMantenimientoConfig(false);
      setShowAlarmasGlobalesConfig(false);
      setShowPruebasBox(false);
      setShowEtoConfig(false);
      setShowDuracionTandaConfig(false);
      setShowAlarmHistory(false);
      setShowActivityLog(false);
      setShowProyectoConfig(false);
    }
  }, [pantallaActiva]);

  // Calcula la programación automática de TODAS las líneas a la vez, en una
  // sola pasada: procesa una a una (en orden), y cada línea tiene en cuenta
  // los huecos que ya han ocupado las líneas anteriores de esta misma
  // pasada, así ninguna se pisa con otra aunque estén en zonas de sol,
  // semisombra o sombra distintas.
  const calcularProgramacionAutomaticaGlobal = () => {
    const etoPorExposicion = { sol: etoSol, semisombra: etoSemisombra, sombra: etoSombra };
    const diasTodos = [...TODOS_LOS_DIAS];
    // Una lista de ocupación acumulada POR CADA ESTACIÓN por separado, ya
    // que el número de tandas (y por tanto los huecos que ocupan) puede ser
    // distinto en cada una.
    const ocupacionAcumuladaPorEstacion = {};
    ESTACIONES.forEach((est) => {
      ocupacionAcumuladaPorEstacion[est.key] = [];
    });
    let sinSuperficie = 0;
    let conflictosTotales = 0;

    const nuevosSectores = sectors.map((s) => {
      if (!s.areaM2 || s.areaM2 <= 0) {
        sinSuperficie++;
        return s;
      }
      const nominalFlowLinea = Number(s.emitters || 0) * Number(s.emitterFlow || 0);
      const etoLinea = etoPorExposicion[s.exposicion] ?? etoSol;
      const { schedules: nuevosSchedules, resumenPorEstacion } = calcularProgramacionAutomaticaTodasEstaciones({
        areaM2: s.areaM2,
        etoBase: etoLinea,
        nominalFlow: nominalFlowLinea,
        duracionSesion: s.duracionTandaAuto ?? 25,
        ocupacionPorEstacion: ocupacionAcumuladaPorEstacion,
        factoresEstacionales,
      });

      ESTACIONES.forEach((est) => {
        conflictosTotales += resumenPorEstacion[est.key].conflictosSinResolver;
        (nuevosSchedules[est.key] || []).forEach((h) => {
          const inicio = horaAMinutos(h.time);
          ocupacionAcumuladaPorEstacion[est.key] = [
            ...ocupacionAcumuladaPorEstacion[est.key],
            { days: diasTodos, inicio, fin: inicio + Number(h.duration || 0), lineName: s.name },
          ];
        });
      });

      return { ...s, schedules: nuevosSchedules };
    });

    setSectors(nuevosSectores);
    const lineasProgramadas = sectors.length - sinSuperficie;
    setResumenProgramacionGlobal({
      lineasProgramadas,
      sinSuperficie,
      conflictosTotales,
      timestamp: new Date().toISOString(),
    });
  };

  const removeSector = (id) => {
    setSectors((prev) => prev.filter((s) => s.id !== id));
  };

  const addSector = () => {
    setSectors((prev) => {
      const numero = prev.length + 1;
      return [
        ...prev,
        {
          id: `sector-${Date.now()}`,
          name: `Línea ${numero}`,
          emitters: 20,
          emitterFlow: 50,
          mode: "horario",
          schedules: generarProgramacionEstacional([nuevoHorario()]),
          thresholds: { humidityMin: 30, humidityMax: 65, ecMin: 1.2, ecMax: 2.4, temperatureMin: 2, temperatureMax: 40, flowMinPercent: 85, flowMaxPercent: 115 },
          sensors: { humidity: 45, temperature: 21, ec: 1.8, flowMeasured: 0, litersToday: 0, lastResetDay: null },
          history: [],
          dailyConsumption: [],
          blockedByLeak: false,
          blockedByFault: false,
          minorLeakFlag: false,
          clogFlag: false,
          humidityFlag: false,
          ecFlag: false,
          temperatureFlag: false,
          manualOverride: null,
          riegoLog: [],
        },
      ];
    });
  };

  if (!sectors) {
    return (
      <div style={{ padding: "2rem", fontFamily: "var(--vc-font-body)", color: "var(--vc-text-muted)" }}>
        Cargando panel de riego…
      </div>
    );
  }

  const totalFlowMeasured = sectors.reduce((sum, s) => sum + Number(s.sensors?.flowMeasured || 0), 0);
  const anyActive =
    (mainSupply && !maestraCerrada && sectors.some((s) => isSectorActiveNow(s, now))) || totalFlowMeasured > 0;
  const pressureOutOfRange = pressureBar < presionBaja || pressureBar > presionAlta;
  const presionEnRangoTrabajo = pressureBar >= presionBaja && pressureBar <= presionAlta;
  // Con varios contadores generales, "litros totales" de hoy viene de sumar
  // los litros reales de cada contador (lo que de verdad ha pasado), no de
  // sumar el litersToday calculado línea a línea.
  const todayTotalLiters =
    contadoresGenerales.length > 0
      ? Math.round(contadoresGenerales.reduce((sum, c) => sum + Number(c.litros_hoy || 0), 0))
      : Math.round(sectors.reduce((sum, s) => sum + Number(s.sensors?.litersToday || 0), 0));
  // Total acumulado: el histórico diario guardado más lo que lleva hoy.
  // Lo que NO se puede hacer es mezclar el histórico inventado de la demo
  // con litros reales, que daría un total falso. Antes eso se decidía
  // mirando si había lecturas reales HOY, y con eso una instalación
  // conectada se quedaba siempre en el total de hoy — aunque su histórico
  // fuera del backend y perfectamente sumable (ver setHistorialDiarioEsReal).
  // Son tres casos, no dos:
  //   histórico real         -> se suma (últimos 90 días, los que pide el bootstrap)
  //   real hoy, sin histórico -> solo hoy
  //   demo                   -> se suma el de la demo, que es coherente consigo mismo
  const hayDatosRealesHoy = (lecturasReales?.porPosicion?.length || 0) > 0;
  const totalConHistorico = Math.round(
    dailyConsumption.reduce((sum, d) => sum + Number(d.liters || 0), 0) + todayTotalLiters
  );
  const totalLitrosHistorico =
    historialDiarioEsReal || !hayDatosRealesHoy ? totalConHistorico : todayTotalLiters;
  const chartConsumoDiario = [...dailyConsumption, { label: "Hoy", liters: todayTotalLiters, isToday: true }];
  const chartConsumoReciente = chartConsumoDiario.slice(-14);
  // Comparativa mensual: agrupa todo el histórico diario (más lo de hoy) por
  // mes, sumando los litros de cada uno, para poder comparar un mes con
  // otro de un vistazo (hasta 12 meses, los más recientes).
  const chartConsumoMensual = (() => {
    const porMes = {};
    chartConsumoDiario.forEach((d) => {
      const fecha = d.isToday ? now : new Date(d.date);
      const clave = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
      if (!porMes[clave]) {
        porMes[clave] = {
          liters: 0,
          label: fecha.toLocaleDateString("es-ES", { month: "short", year: "2-digit" }),
          ordenFecha: fecha,
        };
      }
      porMes[clave].liters += Number(d.liters || 0);
    });
    return Object.values(porMes)
      .sort((a, b) => a.ordenFecha - b.ordenFecha)
      .slice(-12)
      .map((m) => ({ label: m.label, liters: Math.round(m.liters * 10) / 10 }));
  })();
  const promedioPresionHoy =
    pressureCountTodayRef.current > 0
      ? Math.round((pressureSumTodayRef.current / pressureCountTodayRef.current) * 100) / 100
      : pressureBar;
  const chartPresionDiaria = [...pressureDailyHistory, { label: "Hoy", avgPressure: promedioPresionHoy, isToday: true }];
  const chartPresionHoraria = [...pressureHourlyHistory, { label: "Ahora", pressure: pressureBar, isToday: true }];
  const chartFertilizanteDiario = [
    ...fertilizerDailyHistory,
    { label: "Hoy", consumoML: fertilizerConsumedToday, isToday: true },
  ];

  return (
    <div className="vc-root">
      <style>{`
        html, body, :root {
          background: #12201f !important;
          margin: 0;
        }
        .vc-root {
          --vc-bg: #12201f;
          --vc-panel: #1b2b2a;
          --vc-panel-2: #223533;
          --vc-border: #33463f;
          --vc-text: #ededE6;
          --vc-text-muted: #8fa39e;
          --vc-brass: #c19a5b;
          --vc-brass-dark: #8a6f3d;
          --vc-pipe: #3a5049;
          --vc-flow: #4fb6c4;
          --vc-open: #6fcf97;
          --vc-idle: #55655f;
          --vc-amber: #e0a458;
          --vc-heat: #e08a5b;
          --vc-violet: #9b8fd1;
          --vc-red: #e0645b;
          --vc-font-display: 'Oswald', 'Arial Narrow', sans-serif;
          --vc-font-body: 'Inter', system-ui, sans-serif;
          --vc-font-mono: 'IBM Plex Mono', 'Courier New', monospace;
          background: var(--vc-bg);
          color: var(--vc-text);
          font-family: var(--vc-font-body);
          border-radius: 16px;
          padding: 1.75rem;
          width: 100%;
          box-sizing: border-box;
        }
        .vc-root * { box-sizing: border-box; }
        .vc-header {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          margin-bottom: 1.25rem;
          padding-bottom: 1.25rem;
          border-bottom: 1px solid var(--vc-border);
        }
        .vc-header-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
        }
        .vc-supply-toggle-lg {
          padding: 10px 22px;
          font-size: 13px;
          border-width: 2px;
          min-height: 56px;
          box-sizing: border-box;
        }
        .vc-top-buttons {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
          flex-wrap: wrap;
          margin-left: auto;
        }
        .vc-connection-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-open);
          color: var(--vc-open);
          border-radius: 999px;
          padding: 8px 14px;
          font-family: var(--vc-font-mono);
          font-size: 11px;
          white-space: nowrap;
          min-height: 56px;
          box-sizing: border-box;
        }
        .vc-connection-badge-off {
          border-color: var(--vc-red);
          color: var(--vc-red);
        }
        .vc-bateria-badge {
          border-color: var(--vc-amber);
          color: var(--vc-amber);
        }
        .vc-connection-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: currentColor;
          flex-shrink: 0;
        }
        .vc-title {
          font-family: var(--vc-font-display);
          font-weight: 500;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-size: 20px;
          margin: 0 0 4px;
        }
        .vc-co2-lineas-group {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: nowrap;
        }
        .vc-co2-toggle {
          background: #1a3324;
          border-color: #4a8f5c;
          color: #6fcf87;
          cursor: help;
          padding: 10px 12px;
          font-size: 11px;
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .vc-proyecto-btn {
          background: transparent;
          border: none;
          color: var(--vc-text);
          font-size: 20px;
          font-weight: 600;
          font-family: var(--vc-font-display);
          letter-spacing: 0.01em;
          cursor: pointer;
          padding: 0;
          text-align: left;
        }
        .vc-proyecto-fecha-row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .vc-fecha-inline {
          font-size: 11px;
          color: var(--vc-text-muted);
          font-family: var(--vc-font-mono);
          white-space: nowrap;
        }
        .vc-proyecto-config {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 10px;
          padding: 10px 12px;
          margin-top: 10px;
        }
        .vc-proyecto-config code {
          background: var(--vc-panel);
          border-radius: 4px;
          padding: 1px 5px;
          font-family: var(--vc-font-mono);
          font-size: 10px;
        }
        .vc-informe-papel {
          background: #ffffff;
          color: #1a2226;
          border-radius: 6px;
          padding: 0 0 20px;
          overflow: hidden;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-encabezado {
          background: #374550;
          color: #ffffff;
          padding: 22px 22px 16px;
          margin: -20px -20px 18px;
          border-bottom: 5px solid #02bea5;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-cabecera-marca {
          font-size: 17px;
          margin-bottom: 10px;
        }
        .vc-informe-marca-fuerte {
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .vc-informe-marca-suave {
          color: #02bea5;
          font-weight: 500;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-etiqueta {
          display: inline-block;
          background: #02bea5;
          color: #06342c;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.05em;
          padding: 3px 10px;
          border-radius: 3px;
          margin-bottom: 8px;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-titulo-empresa {
          font-weight: 700;
          font-size: 19px;
          margin-bottom: 10px;
        }
        .vc-informe-papel .vc-informe-fila {
          color: #cfe3e0;
          font-size: 12px;
        }
        .vc-informe-papel .vc-history-title {
          background: #e9f5f3;
          color: #02897a;
          padding: 7px 14px;
          margin: 18px 20px 10px !important;
          border-radius: 4px;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          font-weight: 700;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-papel > *:not(.vc-informe-encabezado):not(.vc-history-title) {
          margin-left: 20px;
          margin-right: 20px;
        }
        .vc-informe-papel .vc-history-empty,
        .vc-informe-papel .vc-tecnico-hint {
          color: #5c6b68;
        }
        .vc-informe-resumen {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          margin-top: 10px;
        }
        .vc-informe-resumen-stat {
          background: #e9f5f3;
          border-radius: 6px;
          padding: 10px 4px;
          text-align: center;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-resumen-valor {
          font-family: var(--vc-font-mono);
          font-size: 16px;
          font-weight: 700;
          color: #02897a;
        }
        .vc-informe-resumen-label {
          font-size: 9px;
          color: #4a5a57;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin-top: 2px;
        }
        .vc-informe-incidencias {
          margin-top: 10px;
          font-size: 12px;
          padding: 9px 12px;
          border-radius: 6px;
          background: #fef0d9;
          color: #6b4a10;
          border-left: 3px solid #e0a458;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-consumo-tabla {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .vc-informe-consumo-fila {
          display: grid;
          grid-template-columns: 90px 1fr 60px;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          color: #1a2226;
        }
        .vc-informe-consumo-nombre {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .vc-informe-consumo-barra-wrap {
          background: #e9f5f3;
          border-radius: 4px;
          height: 10px;
          overflow: hidden;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-consumo-barra {
          background: #02bea5;
          height: 100%;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-consumo-valor {
          text-align: right;
          font-family: var(--vc-font-mono);
          color: #1a2226;
        }
        .vc-informe-fertilizante {
          margin-top: 10px;
          font-size: 12px;
          color: #1a2226;
        }
        .vc-informe-mensual-grafica {
          display: flex;
          align-items: flex-end;
          gap: 4px;
          height: 100px;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-mensual-barra-col {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          height: 100%;
          justify-content: flex-end;
        }
        .vc-informe-mensual-barra-wrap {
          width: 100%;
          height: 70px;
          display: flex;
          align-items: flex-end;
        }
        .vc-informe-mensual-barra {
          width: 100%;
          background: #02bea5;
          border-radius: 3px 3px 0 0;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .vc-informe-mensual-valor {
          font-size: 8px;
          font-family: var(--vc-font-mono);
          color: #4a5a57;
          margin-top: 3px;
        }
        .vc-informe-mensual-label {
          font-size: 9px;
          color: #1a2226;
          text-transform: capitalize;
          margin-top: 1px;
        }
        .vc-informe-fila {
          display: flex;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 8px;
          font-size: 12px;
          margin-bottom: 4px;
        }
        .vc-informe-procesos {
          background: #e9f5f3;
          border-radius: 6px;
          padding: 10px 14px;
          color: #1a2226;
          font-size: 12px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .vc-informe-firmas-doble {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .vc-firma-wrap {
          background: #fff;
          border: 1px dashed var(--vc-border);
          border-radius: 10px;
          padding: 4px;
          display: flex;
          justify-content: center;
        }
        .vc-firma-canvas {
          width: 100%;
          max-width: 500px;
          height: 130px;
          touch-action: none;
          cursor: crosshair;
          border-radius: 8px;
        }
        .vc-firma-botones {
          display: flex;
          gap: 8px;
          margin-top: 8px;
          flex-wrap: wrap;
        }
        .vc-firma-guardar-btn {
          color: var(--vc-open);
          border-color: var(--vc-open);
        }
        .vc-informe-solo-print {
          display: none;
        }
        @media print {
          body * {
            visibility: hidden;
          }
          .vc-informe-print,
          .vc-informe-print * {
            visibility: visible;
          }
          .vc-informe-print {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
          }
          .vc-informe-no-print {
            display: none !important;
          }
          .vc-informe-solo-print {
            display: block !important;
          }
        }
        .vc-pantalla-secundaria {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 14px;
          padding: 20px;
          margin-bottom: 1.25rem;
        }
        .vc-plano-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 72px;
          background: var(--vc-bg);
          z-index: 50;
          overflow-y: auto;
          padding: 20px;
        }
        .vc-plano-panel {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 14px;
          padding: 20px;
          max-width: 1200px;
          margin: 0 auto;
        }
        .vc-plano-cerrar-btn {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 999px;
          padding: 7px 14px;
          font-size: 11px;
          cursor: pointer;
        }
        .vc-plano-cerrar-btn:hover {
          border-color: var(--vc-red);
          color: var(--vc-red);
        }
        .vc-listado-resumen {
          font-size: 12px;
          color: var(--vc-text-muted);
          margin: 10px 0;
        }
        .vc-resumen-lineas-tabla {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .vc-resumen-lineas-cabecera,
        .vc-resumen-lineas-fila {
          display: grid;
          grid-template-columns: 1.3fr 1fr 1fr 1fr;
          gap: 8px;
          padding: 6px 10px;
          font-size: 12px;
        }
        .vc-resumen-lineas-cabecera {
          color: var(--vc-text-muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .vc-resumen-lineas-fila {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 6px;
          color: var(--vc-text);
        }
        .vc-listado-tabla {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .vc-listado-fila {
          display: grid;
          grid-template-columns: 110px 1fr 60px 90px;
          align-items: center;
          gap: 8px;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 12px;
        }
        .vc-listado-fila-conflicto {
          border-color: var(--vc-red);
          background: #3a1616;
        }
        .vc-listado-hora {
          font-family: var(--vc-font-mono);
          color: var(--vc-flow);
        }
        .vc-listado-linea {
          font-weight: 500;
        }
        .vc-listado-duracion {
          color: var(--vc-text-muted);
          font-size: 11px;
        }
        .vc-listado-dias {
          color: var(--vc-text-muted);
          font-size: 10px;
          font-family: var(--vc-font-mono);
        }
        .vc-listado-conflicto-txt {
          grid-column: 1 / -1;
          color: var(--vc-red);
          font-size: 11px;
        }
        .vc-huecos-lista {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .vc-hueco-chip {
          background: #1a3336;
          border: 1px solid var(--vc-flow);
          color: var(--vc-flow);
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 11px;
          font-family: var(--vc-font-mono);
        }
        .vc-overlay-top-buttons {
          margin-bottom: 14px;
          padding-bottom: 14px;
          border-bottom: 1px solid var(--vc-border);
        }
        .vc-plano-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          flex-wrap: wrap;
          margin-bottom: 14px;
        }
        .vc-plano-header-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          flex-shrink: 0;
        }
        .vc-plano-imagen-wrap {
          position: relative;
          display: inline-block;
          max-width: 100%;
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid var(--vc-border);
          line-height: 0;
        }
        .vc-plano-imagen {
          display: block;
          max-width: 100%;
          max-height: 72vh;
          width: auto;
          height: auto;
          background: #0a1413;
        }
        .vc-plano-marcador {
          position: absolute;
          width: 27px;
          transform: translate(-50%, -50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          cursor: default;
        }
        .vc-plano-marcador-barra {
          width: 27px;
          height: 11px;
          border-radius: 3px;
          border: 1px solid #12201f;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.15);
          overflow: hidden;
          position: relative;
        }
        .vc-plano-marcador-flujo {
          position: absolute;
          inset: 0;
          background-image: repeating-linear-gradient(
            -45deg,
            rgba(255, 255, 255, 0.4) 0,
            rgba(255, 255, 255, 0.4) 4px,
            transparent 4px,
            transparent 10px
          );
          background-size: 200% 200%;
          animation: vc-flujo-riego 0.8s linear infinite;
        }
        @keyframes vc-flujo-riego {
          from {
            background-position: 0 0;
          }
          to {
            background-position: 20px 0;
          }
        }
        .vc-plano-marcador-on {
          transform: translate(-50%, -50%) scale(1.25);
          z-index: 2;
        }
        .vc-plano-marcador-label {
          font-size: 9px;
          font-weight: 700;
          color: #12201f;
          position: relative;
          z-index: 1;
        }
        .vc-plano-marcador-humedad {
          margin-top: 3px;
          background: #ffffff;
          color: #000000;
          font-size: 11px;
          font-weight: 700;
          font-family: var(--vc-font-mono);
          padding: 1.5px 5px;
          border-radius: 999px;
          border: 1px solid var(--vc-flow);
          white-space: nowrap;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
          line-height: 1.2;
        }
        .vc-plano-lista {
          margin-top: 14px;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          gap: 8px;
        }
        .vc-plano-lista-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 12px;
        }
        .vc-plano-lista-item-doble {
          flex-direction: column;
          align-items: stretch;
          gap: 6px;
        }
        .vc-plano-lista-fila {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .vc-plano-lista-fila-label {
          font-size: 10px;
          color: var(--vc-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .vc-balance-hidrico {
          margin-top: 18px;
          border-top: 1px solid var(--vc-border);
          padding-top: 16px;
        }
        .vc-programacion-params {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 12px;
          padding: 14px;
          margin-bottom: 1.25rem;
        }
        .vc-balance-resultados {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 10px;
          margin-top: 10px;
        }
        .vc-balance-stat {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 10px;
          padding: 10px 12px;
          text-align: center;
        }
        .vc-balance-stat-co2 {
          border-color: #4a8f5c;
        }
        .vc-balance-stat-co2 .vc-balance-stat-value {
          color: #6fcf87;
        }
        .vc-balance-stat-label {
          font-size: 10px;
          color: var(--vc-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin-bottom: 4px;
        }
        .vc-balance-stat-value {
          font-size: 18px;
          font-weight: 600;
          color: var(--vc-text);
        }
        .vc-llave-flujo {
          animation: vc-llave-flujo-anim 0.4s linear infinite;
        }
        @keyframes vc-llave-flujo-anim {
          from {
            stroke-dashoffset: 0;
          }
          to {
            stroke-dashoffset: -5.5;
          }
        }
        .vc-aspas-giro {
          animation: vc-aspas-giro-anim 0.6s linear infinite;
        }
        @keyframes vc-aspas-giro-anim {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        .vc-fert-baja {
          animation: vc-fert-baja-anim 1.4s linear infinite;
        }
        @keyframes vc-fert-baja-anim {
          from {
            transform: translateY(0);
          }
          to {
            transform: translateY(10px);
          }
        }
        .vc-plano-btn-sm {
          background: transparent;
          border: 1px dashed var(--vc-border);
          color: var(--vc-flow);
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 10px;
          cursor: pointer;
        }
        .vc-plano-btn-sm-on {
          border-style: solid;
          border-color: var(--vc-flow);
          background: #1a3336;
        }
        .vc-plano-btn-sm-quitar {
          color: var(--vc-red);
        }
        .vc-plano-input-sm {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 6px;
          padding: 4px 6px;
          font-size: 11px;
          width: 70px;
        }
        .vc-plano-lista-fila-unidad {
          font-size: 10px;
          color: var(--vc-text-muted);
        }
        .vc-subtitle {
          font-size: 12px;
          color: var(--vc-text-muted);
          font-family: var(--vc-font-mono);
          margin: 6px 0 10px;
        }
        .vc-header-actions {
          display: flex;
          flex-direction: row;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        }
        .vc-supply-toggle {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 999px;
          padding: 7px 14px;
          font-family: var(--vc-font-mono);
          font-size: 11px;
          letter-spacing: 0.02em;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 7px;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .vc-supply-toggle:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .vc-supply-toggle-on {
          border-color: var(--vc-flow);
          color: var(--vc-flow);
        }
        .vc-reset-toggle {
          color: var(--vc-text-muted);
          border-style: dashed;
        }
        .vc-supply-toggle-auto {
          border-color: var(--vc-flow);
          color: var(--vc-flow);
        }
        .vc-box-left {
          margin-right: auto;
        }
        .vc-test-box {
          border-style: dashed;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .vc-pruebas-aviso {
          width: 100%;
          margin: 0 0 8px;
          color: var(--vc-amber);
        }
        .vc-box-separador {
          width: 1px;
          height: 20px;
          background: var(--vc-border);
          margin: 0 2px;
        }
        .vc-icon-only-btn-on {
          color: var(--vc-red);
        }
        .vc-programacion-box {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 4px;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 999px;
          padding: 6px 10px;
          min-height: 56px;
          box-sizing: border-box;
        }
        .vc-icon-only-btn {
          background: transparent;
          border: none;
          color: var(--vc-flow);
          padding: 4px 6px;
          font-size: 16px;
          cursor: pointer;
        }
        .vc-resumen-programacion-global {
          background: #1a3336;
          border: 1px solid var(--vc-flow);
          border-radius: 10px;
          padding: 8px 12px;
          margin-top: 10px;
          font-size: 12px;
          color: var(--vc-text);
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .vc-resumen-cerrar-btn {
          background: transparent;
          border: none;
          color: var(--vc-text-muted);
          cursor: pointer;
          font-size: 13px;
          margin-left: auto;
          flex-shrink: 0;
        }
        .vc-reset-toggle:hover {
          border-color: var(--vc-red);
          color: var(--vc-red);
        }
        .vc-reset-confirm {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          background: #3a1616;
          border: 1px solid var(--vc-red);
          border-radius: 16px;
          padding: 7px 14px;
          font-size: 11px;
          color: #ffd9d5;
          white-space: normal;
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .vc-reset-confirm-yes {
          background: var(--vc-red);
          color: #3a1616;
          border: none;
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 10px;
          font-weight: 500;
          cursor: pointer;
        }
        .vc-reset-confirm-no {
          background: transparent;
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 10px;
          cursor: pointer;
        }
        .vc-maestra-banner {
          background: #3a1616;
          border: 2px solid var(--vc-red);
          border-radius: 12px;
          padding: 16px;
          margin-bottom: 1.25rem;
        }
        .vc-maestra-titulo {
          color: var(--vc-red);
          font-weight: 700;
          font-size: 15px;
          margin-bottom: 8px;
        }
        .vc-maestra-motivo {
          font-size: 13px;
          color: var(--vc-text);
          margin: 0 0 6px;
        }
        .vc-maestra-hora {
          font-size: 11px;
          color: var(--vc-text-muted);
          margin: 0 0 12px;
        }
        .vc-maestra-rearmar {
          background: var(--vc-red);
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 10px 16px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .vc-maestra-confirm {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
          font-size: 12px;
          color: #ffd9d5;
        }
        .vc-maestra-confirm-yes {
          background: var(--vc-red);
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 8px 14px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .vc-maestra-confirm-no {
          background: transparent;
          color: #ffd9d5;
          border: 1px solid var(--vc-red);
          border-radius: 8px;
          padding: 8px 14px;
          font-size: 12px;
          cursor: pointer;
        }
        .vc-leak-stack {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 1.25rem;
        }
        .vc-leak-banner {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
          background: #3a1616;
          border: 1px solid var(--vc-red);
          color: #ffd9d5;
          border-radius: 10px;
          padding: 10px 16px;
          font-size: 13px;
        }
        .vc-leak-rearm {
          background: var(--vc-red);
          color: #3a1616;
          border: none;
          border-radius: 7px;
          padding: 8px 14px;
          font-weight: 500;
          font-size: 12px;
          cursor: pointer;
          white-space: nowrap;
        }
        .vc-leak-rearm:hover {
          background: #f28c85;
        }
        .vc-blocked-banner {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #3a1616;
          border: 1px solid var(--vc-red);
          color: #ffd9d5;
          border-radius: 8px;
          padding: 6px 10px;
          font-size: 11px;
        }
        .vc-blocked-banner-fault {
          background: #2a2340;
          border-color: var(--vc-violet);
          color: #e3ddf7;
        }
        .vc-leak-banner-pressure {
          background: #3a2f16;
          border-color: var(--vc-amber);
          color: #ffe8c2;
        }
        .vc-leak-banner-multi {
          background: #2a2340;
          border-color: var(--vc-violet);
          color: #e3ddf7;
        }
        .vc-leak-rearm-sm {
          padding: 4px 10px;
          font-size: 11px;
        }
        .vc-summary-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 10px;
          margin-bottom: 1.25rem;
        }
        .vc-summary-row-3 {
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 6px;
          position: relative;
        }
        .vc-alarm-dropdown-wrap.vc-dropdown-wrap-row {
          position: static;
        }
        .vc-alarm-dropdown.vc-dropdown-centered {
          left: 50%;
          right: auto;
          transform: translateX(-50%);
          width: 100%;
          max-width: 92vw;
          max-height: none;
          overflow-y: visible;
        }
        .vc-summary-row.vc-summary-row-full {
          grid-template-columns: 1fr;
        }
        .vc-tecnico-cliente-stack {
          display: flex;
          flex-direction: row;
          flex-wrap: wrap;
          gap: 10px;
          min-width: 0;
          position: relative;
        }
        .vc-tecnico-cliente-stack > .vc-alarm-dropdown-wrap {
          flex: 1;
          min-width: 120px;
        }
        .vc-summary-card {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 10px;
          padding: 10px 12px;
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .vc-summary-card-narrow {
          padding: 10px 8px;
        }
        .vc-summary-card-compact {
          padding: 6px 8px;
          gap: 5px;
        }
        .vc-tecnico-btn-alto {
          padding: 28px 8px;
          min-width: 0;
          overflow: hidden;
          box-sizing: border-box;
        }
        .vc-tecnico-btn-bajo {
          padding: 12px 8px;
        }
        .vc-tecnico-btn-bajo .vc-tecnico-icono {
          font-size: 32px;
        }
        .vc-tecnico-btn-alto .vc-summary-label {
          font-size: 9px;
          display: flex;
          flex-direction: column;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: 4px;
          white-space: normal;
          text-align: center;
        }
        .vc-tecnico-btn-alto .vc-summary-value {
          white-space: normal;
          word-break: break-word;
          text-align: center;
        }
        .vc-tecnico-icono {
          font-size: 60px;
          line-height: 1;
        }
        .vc-summary-card-compact .vc-summary-label {
          font-size: 9px;
          margin-bottom: 1px;
        }
        .vc-summary-card-compact .vc-summary-value {
          font-size: 13px;
        }
        .vc-summary-card-mini {
          padding: 1px 5px;
          max-width: 60px;
          flex: 0 0 auto;
          align-self: start;
          height: fit-content;
        }
        .vc-summary-card-mini .vc-summary-label {
          font-size: 7px;
          margin-bottom: 0;
          line-height: 1;
        }
        .vc-summary-card-mini .vc-summary-value {
          font-size: 11px;
          line-height: 1.1;
        }
        .vc-summary-card-vertical {
          flex-direction: column;
          justify-content: center;
          gap: 4px;
          align-self: start;
        }
        .vc-summary-icon-box {
          height: 46px;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }
        .vc-summary-text-center {
          align-items: center;
          text-align: center;
        }
        .vc-summary-card-btn {
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          font-family: inherit;
          cursor: pointer;
          text-align: left;
        }
        .vc-summary-card-btn:hover {
          border-color: var(--vc-border-strong, var(--vc-border));
        }
        .vc-summary-card-on {
          border-color: var(--vc-flow);
        }
        .vc-summary-text { display: flex; flex-direction: column; }
        .vc-summary-label {
          font-size: 11px;
          color: var(--vc-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 4px;
        }
        .vc-summary-value {
          font-family: var(--vc-font-mono);
          font-size: 18px;
        }
        .vc-summary-value-sub {
          font-size: 16px;
          font-weight: 700;
          color: var(--vc-text-muted);
        }
        .vc-estado-red-texto {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .vc-collector-wrap {
          margin-bottom: 1.5rem;
        }
        .vc-collector-status {
          text-align: center;
          font-size: 11px;
          font-family: var(--vc-font-mono);
          color: var(--vc-text-muted);
          margin-top: -4px;
        }
        .vc-charts-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 14px;
          margin-bottom: 1.5rem;
        }
        .vc-chart-card {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 12px;
          padding: 12px 14px 4px;
          min-width: 0;
          box-sizing: border-box;
        }
        .vc-chart-title {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 4px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--vc-text-muted);
          margin-bottom: 4px;
        }
        .vc-chart-current {
          font-family: var(--vc-font-mono);
          font-size: 14px;
          text-transform: none;
          letter-spacing: 0;
        }
        .vc-chart-empty {
          font-size: 12px;
          color: var(--vc-text-muted);
          padding: 40px 0;
          text-align: center;
        }
        .vc-annual-toggle {
          width: 100%;
          margin-top: 6px;
          margin-bottom: 4px;
        }
        .vc-toggle-btn.vc-borrar-historial-btn {
          color: var(--vc-red);
          border-color: var(--vc-red);
        }
        .vc-annual-chart-wrap {
          border-top: 1px solid var(--vc-border);
          padding-top: 8px;
          margin-top: 4px;
        }
        .vc-chart-clip {
          width: 100%;
          max-width: 100%;
          overflow: hidden;
        }
        .vc-hourly-detail {
          border-top: 1px solid var(--vc-border);
          margin-top: 10px;
          padding-top: 10px;
        }
        .vc-hourly-detail-title {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11px;
          color: var(--vc-text-muted);
          margin-bottom: 6px;
        }
        .vc-cal-dia-cerrar-btn {
          background: transparent;
          border: none;
          color: var(--vc-text-muted);
          cursor: pointer;
          font-size: 13px;
          padding: 0 4px;
        }
        .vc-cal-dia-cerrar-btn:hover {
          color: var(--vc-red);
        }
        .vc-chart-nav {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          margin-top: 6px;
          flex-wrap: wrap;
        }
        .vc-chart-nav-btn {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-flow);
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 10px;
          cursor: pointer;
          white-space: nowrap;
        }
        .vc-chart-nav-btn:disabled {
          color: var(--vc-text-muted);
          cursor: not-allowed;
          opacity: 0.5;
        }
        .vc-chart-nav-btn:not(:disabled):hover {
          border-color: var(--vc-flow);
        }
        .vc-chart-nav-hoy {
          color: var(--vc-brass);
        }
        .vc-chart-nav-label {
          font-size: 10px;
          font-family: var(--vc-font-mono);
          color: var(--vc-text-muted);
        }
        .vc-outage-log {
          margin-top: 10px;
          border-top: 1px solid var(--vc-border);
          padding-top: 8px;
          max-height: 200px;
          overflow-y: auto;
        }
        .vc-outage-log-title {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--vc-text-muted);
          margin-bottom: 6px;
        }
        .vc-outage-log-item {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          font-family: var(--vc-font-mono);
          color: var(--vc-red);
          background: #3a1616;
          border-radius: 6px;
          padding: 5px 8px;
          margin-bottom: 4px;
        }
        .vc-flow-alarm-item-leve {
          color: var(--vc-amber);
          background: #2a2318;
        }
        .vc-flow-alarm-item-grave {
          color: var(--vc-red);
          background: #3a1616;
        }
        .vc-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
          gap: 10px;
          align-items: start;
        }
        .vc-card {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 12px;
          padding: 12px 12px 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          position: relative;
          z-index: 1;
        }
        .vc-card-leak {
          border: 2px solid var(--vc-red);
          background: linear-gradient(180deg, #3a1616 0%, var(--vc-panel) 90px);
        }
        .vc-card-wide {
          grid-column: 1 / -1;
        }
        .vc-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .vc-card-title {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
        }
        .vc-name-input {
          background: transparent;
          border: none;
          color: var(--vc-text);
          font-family: var(--vc-font-display);
          font-size: 14px;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          width: 100%;
          padding: 2px 0;
          min-width: 0;
        }
        .vc-name-input:focus {
          outline: none;
          border-bottom: 1px solid var(--vc-brass);
        }
        .vc-icon-btn {
          background: transparent;
          border: 1px solid var(--vc-border);
          color: var(--vc-text-muted);
          width: 24px;
          height: 24px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 15px;
          line-height: 1;
          flex-shrink: 0;
        }
        .vc-icon-btn:hover {
          border-color: var(--vc-red);
          color: var(--vc-red);
        }
        .vc-confirm-delete {
          display: flex;
          flex-direction: column;
          gap: 8px;
          background: #3a1616;
          border: 1px solid var(--vc-red);
          color: #ffd9d5;
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 11px;
        }
        .vc-confirm-delete-actions {
          display: flex;
          gap: 8px;
        }
        .vc-confirm-cancel {
          flex: 1;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 6px;
          padding: 7px 8px;
          font-size: 11px;
          cursor: pointer;
        }
        .vc-confirm-yes {
          flex: 1;
          background: var(--vc-red);
          color: #3a1616;
          border: none;
          border-radius: 6px;
          padding: 7px 8px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
        }
        .vc-confirm-yes:hover {
          background: #f28c85;
        }
        .vc-card-body {
          display: flex;
          align-items: center;
          gap: 14px;
          background: var(--vc-panel-2);
          border-radius: 10px;
          padding: 10px 14px;
        }
        .vc-readout {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .vc-readout-label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--vc-text-muted);
        }
        .vc-readout-value {
          font-family: var(--vc-font-mono);
          font-size: 15px;
        }
        .vc-sensor-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 6px;
        }
        .vc-sensor {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 7px;
          padding: 6px 8px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .vc-sensor-warn {
          border-color: var(--vc-red);
        }
        .vc-sensor-clickable {
          cursor: pointer;
        }
        .vc-sensor-clickable:hover {
          border-color: var(--vc-flow);
        }
        .vc-sensor-active {
          border-color: var(--vc-flow);
          background: #1a3336;
        }
        .vc-sensor-wide {
          grid-column: 1 / -1;
          flex-direction: row;
          align-items: baseline;
          justify-content: space-between;
        }
        .vc-sensor-label {
          font-size: 10px;
          color: var(--vc-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .vc-sensor-value {
          font-family: var(--vc-font-mono);
          font-size: 14px;
        }
        .vc-sensor-unit {
          font-size: 10px;
          color: var(--vc-text-muted);
          margin-left: 2px;
        }
        .vc-mini-charts-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
        }
        .vc-combined-chart-wrap {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 10px;
          padding: 10px 12px;
        }
        .vc-mini-chart {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 8px;
          padding: 8px 8px 2px;
        }
        .vc-mini-chart-title {
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--vc-text-muted);
          margin-bottom: 2px;
          font-family: var(--vc-font-mono);
        }
        .vc-day-tabs {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-bottom: 8px;
        }
        .vc-day-tab {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-text-muted);
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 10px;
          cursor: pointer;
          white-space: nowrap;
        }
        .vc-day-tab-on {
          border-color: var(--vc-flow);
          color: var(--vc-flow);
        }
        .vc-chart-empty-sm {
          padding: 20px 0;
          font-size: 11px;
        }
        .vc-alert-line {
          font-size: 11px;
          color: var(--vc-red);
        }
        .vc-alert-ok {
          color: var(--vc-open);
        }
        .vc-alert-pressure-first {
          color: var(--vc-amber);
          font-weight: 500;
        }
        .vc-alert-escorrentia {
          color: var(--vc-amber);
          font-weight: 500;
        }
        .vc-alert-deficit {
          color: var(--vc-red);
          font-weight: 500;
        }
        .vc-mode-toggle {
          display: flex;
          gap: 4px;
        }
        .vc-mode-btn {
          flex: 1;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-text-muted);
          border-radius: 7px;
          padding: 6px 4px;
          font-size: 11px;
          line-height: 1.2;
          cursor: pointer;
          font-family: var(--vc-font-body);
        }
        .vc-mode-btn-on {
          border-color: var(--vc-brass);
          color: var(--vc-text);
          background: #2a2318;
        }
        .vc-manual-block {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 7px;
          padding: 6px 8px;
        }
        .vc-manual-input {
          width: 48px;
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 6px;
          padding: 5px 6px;
          font-size: 12px;
          font-family: var(--vc-font-mono);
        }
        .vc-manual-unit {
          font-size: 11px;
          color: var(--vc-text-muted);
        }
        .vc-manual-start {
          flex: 1;
          background: var(--vc-flow);
          color: #08282c;
          border: none;
          border-radius: 6px;
          padding: 7px 8px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
        }
        .vc-manual-start:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .vc-manual-countdown {
          flex: 1;
          font-size: 11px;
          color: var(--vc-flow);
          font-family: var(--vc-font-mono);
        }
        .vc-manual-stop {
          background: var(--vc-red);
          color: #3a1616;
          border: none;
          border-radius: 6px;
          padding: 7px 12px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
        }
        .vc-sensor-hint {
          font-size: 11px;
          color: var(--vc-violet);
          font-family: var(--vc-font-mono);
        }
        .vc-next-event {
          font-size: 12px;
          color: var(--vc-text-muted);
          font-family: var(--vc-font-mono);
        }
        .vc-exposicion-fila {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--vc-text-muted);
        }
        .vc-next-event strong {
          color: var(--vc-text);
          font-weight: 400;
        }
        .vc-event-count {
          color: var(--vc-text-muted);
        }
        .vc-link-btn {
          background: transparent;
          border: none;
          color: var(--vc-flow);
          font-size: 12px;
          cursor: pointer;
          padding: 0;
          text-align: left;
        }
        .vc-toggle-row {
          display: flex;
          gap: 8px;
        }
        .vc-toggle-btn {
          flex: 1;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-flow);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 11px;
          cursor: pointer;
          text-align: center;
        }
        .vc-toggle-btn:hover {
          border-color: var(--vc-flow);
        }
        .vc-schedule-editor {
          border-top: 1px solid var(--vc-border);
          padding-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .vc-auto-programa {
          background: var(--vc-panel-2);
          border: 1px dashed var(--vc-flow);
          border-radius: 10px;
          padding: 10px;
        }
        .vc-auto-duracion-label {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--vc-text);
          margin-bottom: 8px;
        }
        .vc-season-tabs {
          display: flex;
          gap: 4px;
          position: sticky;
          top: 0;
          background: var(--vc-panel);
          padding-bottom: 4px;
          z-index: 1;
        }
        .vc-season-tab {
          flex: 1;
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-text-muted);
          border-radius: 7px;
          padding: 6px 4px;
          font-size: 11px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }
        .vc-season-tab-on {
          border-color: var(--vc-flow);
          color: var(--vc-text);
          background: #1a3336;
        }
        .vc-season-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--vc-open);
          display: inline-block;
        }
        .vc-event-block {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 8px;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .vc-event-block-conflicto {
          border-color: var(--vc-red);
          background: #3a1616;
        }
        .vc-conflicto-hint {
          font-size: 10px;
          color: var(--vc-red);
          margin: 0;
          line-height: 1.4;
        }
        .vc-event-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .vc-event-title {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--vc-brass);
          font-family: var(--vc-font-mono);
        }
        .vc-event-remove {
          background: transparent;
          border: 1px solid var(--vc-border);
          color: var(--vc-text-muted);
          width: 20px;
          height: 20px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 13px;
          line-height: 1;
        }
        .vc-event-remove:hover {
          border-color: var(--vc-red);
          color: var(--vc-red);
        }
        .vc-add-event-btn {
          background: transparent;
          border: 1px dashed var(--vc-border);
          color: var(--vc-flow);
          border-radius: 8px;
          padding: 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .vc-add-event-btn:hover {
          border-color: var(--vc-flow);
        }
        .vc-add-event-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .vc-threshold-title {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--vc-text-muted);
          border-top: 1px solid var(--vc-border);
          padding-top: 10px;
        }
        .vc-day-row {
          display: flex;
          gap: 4px;
        }
        .vc-day {
          flex: 1;
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          color: var(--vc-text-muted);
          border-radius: 6px;
          padding: 5px 0;
          font-size: 11px;
          cursor: pointer;
        }
        .vc-day-on {
          background: var(--vc-flow);
          border-color: var(--vc-flow);
          color: #08282c;
          font-weight: 500;
        }
        .vc-field-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .vc-thresholds-note {
          font-size: 10px;
          color: var(--vc-amber);
          background: #2a2318;
          border: 1px solid var(--vc-amber);
          border-radius: 6px;
          padding: 8px 10px;
          margin: 4px 0 0;
          line-height: 1.4;
        }
        .vc-field-row label {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 11px;
          color: var(--vc-text-muted);
          flex: 1;
          min-width: 90px;
        }
        .vc-field-row input,
        .vc-field-row select {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 12px;
          font-family: var(--vc-font-mono);
        }
        .vc-add-card {
          background: transparent;
          border: 1px dashed var(--vc-border);
          border-radius: 999px;
          color: var(--vc-text-muted);
          cursor: pointer;
          margin-top: 10px;
          padding: 8px 16px;
          font-size: 12px;
        }
        .vc-add-card:hover {
          border-color: var(--vc-brass);
          color: var(--vc-brass);
        }
        .vc-history {
          margin-top: 1.5rem;
          border-top: 1px solid var(--vc-border);
          padding-top: 12px;
        }
        .vc-history-title {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--vc-text-muted);
          margin-bottom: 8px;
        }
        .vc-history-title-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
        }
        .vc-history-title-row .vc-history-title {
          margin-bottom: 0;
        }
        .vc-history-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 11px;
          font-family: var(--vc-font-mono);
          color: var(--vc-text-muted);
          padding: 5px 0;
          border-bottom: 1px solid var(--vc-panel-2);
        }
        .vc-history-item span:first-child {
          color: var(--vc-text);
        }
        .vc-history-empty {
          font-size: 12px;
          color: var(--vc-text-muted);
        }
        .vc-riego-log {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-height: 320px;
          overflow-y: auto;
        }
        .vc-riego-log-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          font-family: var(--vc-font-mono);
          color: var(--vc-text-muted);
          background: var(--vc-panel-2);
          border-radius: 6px;
          padding: 5px 8px;
        }
        .vc-riego-tag {
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          padding: 2px 6px;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .vc-riego-tag-horario {
          background: #1a3336;
          color: var(--vc-flow);
        }
        .vc-riego-tag-sensor {
          background: #2a2340;
          color: var(--vc-violet);
        }
        .vc-riego-tag-manual {
          background: #2a2318;
          color: var(--vc-brass);
        }
        .vc-riego-tag-fuga {
          background: #3a1616;
          color: var(--vc-red);
        }
        .vc-riego-tag-fuga-ok {
          background: #163a1e;
          color: var(--vc-open);
        }
        .vc-history-title-sub {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--vc-panel-2);
        }
        .vc-riego-log-time {
          flex: 1;
        }
        .vc-riego-log-stats {
          color: var(--vc-text);
          white-space: nowrap;
        }
        .vc-alarm-dropdown-wrap {
          position: relative;
        }
        .vc-alarm-dropdown {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          z-index: 30;
          width: 320px;
          max-width: 92vw;
          max-height: 320px;
          overflow-y: auto;
          overflow-x: hidden;
          box-sizing: border-box;
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 10px;
          padding: 12px 14px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        }
        .vc-alarm-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 11px;
          font-family: var(--vc-font-mono);
          padding: 6px 0;
          border-bottom: 1px solid var(--vc-panel-2);
        }
        .vc-alarm-item-row {
          display: flex;
          justify-content: space-between;
          gap: 8px;
        }
        .vc-alarm-item-actions {
          display: flex;
          gap: 12px;
        }
        .vc-alarm-notify-link {
          color: var(--vc-flow);
          text-decoration: none;
          font-size: 10px;
        }
        .vc-alarm-notify-link-cliente {
          color: var(--vc-brass);
        }
        .vc-cliente-informe-btn {
          background: var(--vc-brass);
          color: #221a0c;
          border: none;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          margin-top: 4px;
        }
        .vc-cliente-informe-btn:disabled {
          background: var(--vc-panel-2);
          color: var(--vc-text-muted);
          cursor: not-allowed;
        }
        .vc-informe-whatsapp-btn {
          background: #25d366;
          color: #04160c;
        }
        .vc-cliente-copiar-btn {
          background: transparent;
          border: 1px dashed var(--vc-border);
          color: var(--vc-flow);
          border-radius: 8px;
          padding: 7px 10px;
          font-size: 10px;
          cursor: pointer;
          margin-top: 4px;
        }
        .vc-cliente-copiar-btn:hover {
          border-color: var(--vc-flow);
        }
        .vc-cliente-copiar-btn:disabled {
          color: var(--vc-text-muted);
          cursor: not-allowed;
        }
        .vc-alarm-notify-link:hover {
          text-decoration: underline;
        }
        .vc-alarm-notify-off {
          font-size: 10px;
          color: var(--vc-text-muted);
          font-style: italic;
        }
        .vc-alarm-item-detected {
          color: var(--vc-red);
        }
        .vc-alarm-item-resolved {
          color: var(--vc-open);
        }
        .vc-alarm-line-name {
          color: var(--vc-text);
        }
        .vc-leak-actions {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .vc-leak-notify {
          color: #ffd9d5;
          text-decoration: underline;
          font-size: 12px;
          white-space: nowrap;
        }
        .vc-tecnico-form {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: 280px;
          max-height: 440px;
        }
        .vc-tecnico-hint {
          font-size: 10px;
          color: var(--vc-text-muted);
          line-height: 1.4;
          margin: 0 0 4px;
        }
        .vc-tecnico-field {
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-size: 11px;
          color: var(--vc-text-muted);
        }
        .vc-tecnico-field input,
        .vc-tecnico-field textarea,
        .vc-tecnico-field select {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 12px;
          font-family: var(--vc-font-body);
          resize: vertical;
        }
        .vc-mantenimiento-box {
          background: var(--vc-panel-2);
          border: 1px solid var(--vc-border);
          border-radius: 10px;
          padding: 10px 12px;
          margin: 4px 0;
        }
        .vc-mantenimiento-fecha {
          font-size: 12px;
          color: var(--vc-text);
          margin-bottom: 8px;
        }
        .vc-mini-cal-grid-meses {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          gap: 10px;
          margin-top: 8px;
        }
        .vc-mini-cal-mes {
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          border-radius: 8px;
          padding: 6px;
        }
        .vc-mini-cal-mes-nombre {
          font-size: 10px;
          text-transform: capitalize;
          text-align: center;
          color: var(--vc-text-muted);
          margin-bottom: 4px;
        }
        .vc-mini-cal-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 1px;
        }
        .vc-mini-cal-dow {
          font-size: 8px;
          text-align: center;
          color: var(--vc-text-muted);
          padding-bottom: 2px;
        }
        .vc-mini-cal-dia {
          font-size: 9px;
          text-align: center;
          padding: 2px 0;
          border-radius: 3px;
          color: var(--vc-text-muted);
        }
        .vc-mini-cal-dia-hoy {
          border: 1px solid var(--vc-flow);
          color: var(--vc-text);
        }
        .vc-mini-cal-dia-on {
          background: var(--vc-violet);
          color: #fff;
          font-weight: 700;
        }
        .vc-tecnico-alarmas-title {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--vc-text-muted);
          border-top: 1px solid var(--vc-border);
          padding-top: 8px;
          margin-top: 4px;
        }
        .vc-tecnico-checks {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .vc-tecnico-check {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          color: var(--vc-text);
          cursor: pointer;
        }
        .vc-tecnico-check input {
          accent-color: var(--vc-flow);
          width: 14px;
          height: 14px;
          flex-shrink: 0;
        }
        .vc-fertilizer-dropdown {
          width: 300px;
        }
        .vc-fertilizer-level-row {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: var(--vc-text-muted);
          border-top: 1px solid var(--vc-border);
          padding-top: 8px;
          margin-top: 8px;
          font-family: var(--vc-font-mono);
        }
        @media (max-width: 480px) {
          .vc-root { padding: 1.1rem; }
          .vc-grid { grid-template-columns: 1fr; }
          .vc-alarm-dropdown { right: auto; left: 0; width: calc(100vw - 32px); max-width: calc(100vw - 32px); }
          .vc-mini-charts-grid { grid-template-columns: 1fr; }
          .vc-charts-row { grid-template-columns: 1fr; }
          .vc-summary-row { grid-template-columns: repeat(2, 1fr); }
          .vc-summary-row-3 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
          .vc-informe-firmas-doble { grid-template-columns: 1fr; }
          .vc-informe-resumen { grid-template-columns: repeat(2, 1fr); }
          .vc-top-buttons {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 4px;
            width: 100%;
          }
          .vc-co2-lineas-group {
            display: contents;
          }
          .vc-connection-badge,
          .vc-supply-toggle-lg {
            padding: 5px 4px;
            font-size: 9px;
            min-height: 40px;
            width: 100%;
            max-width: none;
            box-sizing: border-box;
            justify-content: center;
            white-space: normal;
            text-overflow: clip;
            line-height: 1.2;
            gap: 2px;
          }
          .vc-supply-toggle-lg svg {
            transform: scale(0.6);
            margin: -6px -4px;
          }
          .vc-header-actions {
            flex-wrap: nowrap;
            overflow-x: auto;
            justify-content: flex-start;
            padding-bottom: 4px;
          }
          .vc-box-left {
            margin-right: 0;
          }
        }
        .vc-tabbar-spacer {
          height: 72px;
        }
        .vc-tabbar {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 20;
          display: flex;
          background: var(--vc-panel);
          border-top: 1px solid var(--vc-border);
          padding: 6px 4px calc(6px + env(safe-area-inset-bottom, 0px));
        }
        .vc-tabbar-btn {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          background: transparent;
          border: none;
          color: var(--vc-text-muted);
          font-family: var(--vc-font-mono);
          font-size: 10px;
          padding: 6px 2px;
          cursor: pointer;
          border-radius: 10px;
        }
        .vc-tabbar-icon {
          font-size: 20px;
          line-height: 1;
        }
        .vc-tabbar-btn-on {
          color: var(--vc-flow);
          background: var(--vc-panel-2);
        }
        .vc-salir-fixed {
          position: fixed;
          top: 10px;
          right: 10px;
          z-index: 40;
          display: inline-block;
          background: var(--vc-panel);
          border: 1px solid var(--vc-border);
          color: var(--vc-text);
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 12px;
          font-family: var(--vc-font-body);
          text-decoration: none;
          cursor: pointer;
        }
        @media (max-width: 640px) {
          .vc-salir-fixed {
            top: 6px;
            right: 6px;
            padding: 5px 11px;
            font-size: 11px;
          }
          /* El botón "salir" es fijo (no ocupa espacio en el flujo normal),
             así que sin este hueco arriba el título largo ("Verdtical ·
             sistema de riego inteligente") puede quedar tapado debajo. */
          .vc-root {
            padding-top: 42px;
          }
        }
      `}</style>

      <a className="vc-salir-fixed" href={URL_LANZADOR} title="Volver al listado de instalaciones (no cierra tu sesión)">
        ← instalaciones
      </a>

      <div className="vc-header">
        <div className="vc-header-top">
          <div>
            <p className="vc-title">Verdtical · sistema de riego inteligente</p>
            <div className="vc-proyecto-fecha-row">
              <button className="vc-proyecto-btn" onClick={() => setShowProyectoConfig((v) => !v)}>
                📍 {proyecto.nombre || "Verdtical"}
              </button>
              <span className="vc-fecha-inline">
                {now.toLocaleDateString("es-ES", { weekday: "long", day: "2-digit", month: "short" })} · {pad2(now.getHours())}:{pad2(now.getMinutes())}
              </span>
            </div>
          </div>
          <div className="vc-top-buttons">
            <div
              className={datosActivos ? "vc-connection-badge" : "vc-connection-badge vc-connection-badge-off"}
              title={datosActivos ? "Recibiendo datos con normalidad" : "Sin datos — comunicación perdida o batería del PLC agotada"}
            >
              <span className="vc-connection-dot" />
              {datosActivos ? "en línea" : "sin datos"}
            </div>
            {plcSinCorriente && (
              <div
                className={
                  bateriaPlcNivel <= bateriaUmbralBaja ? "vc-connection-badge vc-connection-badge-off" : "vc-connection-badge vc-bateria-badge"
                }
                title={`Batería de respaldo del PLC: ${bateriaPlcNivel}% — se está descargando porque no hay corriente en el PLC`}
              >
                🔋 {bateriaPlcNivel}%
              </div>
            )}
            <button
              className="vc-supply-toggle vc-supply-toggle-lg"
              onClick={() => setMainSupply((v) => !v)}
              title="Corte general de riego: apagado, no se puede activar ninguna electroválvula. Es independiente de si el panel tiene datos o no — la falta de datos no apaga el sistema. No confundir con la electroválvula maestra, en la tarjeta 'Estado red'."
            >
              <StatusDot active={mainSupply} mode="horario" />
              sistema {mainSupply ? "activado" : "apagado"}
            </button>
            {(() => {
              const co2Kg = Math.round(((totalLitrosHistorico * wueGramosPorLitro * 0.45 * 3.667) / 1000) * 100) / 100;
              return (
                <div className="vc-co2-lineas-group">
                  <div
                    className="vc-supply-toggle vc-supply-toggle-lg vc-co2-toggle"
                    title="Estimación orientativa de CO₂ capturado en total, desde el histórico acumulado (hasta 365 días) — ver detalle y ajustar en el Plano"
                  >
                    <span style={{ fontSize: 20 }}>🌱</span>{" "}
                    {co2Kg} kg CO₂ total
                  </div>
                  <div className="vc-supply-toggle vc-supply-toggle-lg vc-lineas-toggle" title="Número de líneas de riego configuradas">
                    💧 {sectors.length} líneas
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
        {showProyectoConfig && (
          <div className="vc-proyecto-config">
            {proyecto.direccion ? (
              <a
                href={
                  proyecto.lat != null && proyecto.lon != null
                    ? `https://www.google.com/maps/search/?api=1&query=${proyecto.lat},${proyecto.lon}`
                    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(proyecto.direccion)}`
                }
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--vc-flow)", fontSize: 13, textDecoration: "none" }}
              >
                🧭 {proyecto.direccion} — abrir en Google Maps →
              </a>
            ) : (
              <p className="vc-tecnico-hint" style={{ margin: 0 }}>
                Esta instalación todavía no tiene dirección configurada — se edita desde Verdtical Central.
              </p>
            )}
          </div>
        )}
      </div>
        {pantallaActiva === "programacion" && (
          <div className="vc-tecnico-cliente-stack" style={{ marginBottom: "1.25rem" }}>
            <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row">
              <button
                className="vc-summary-card vc-summary-card-btn vc-summary-card-compact vc-tecnico-btn-alto vc-tecnico-btn-bajo"
                onClick={() => setConfirmProgramarAuto(true)}
                title="Programar automáticamente TODAS las líneas (según superficie, exposición y evapotranspiración de cada una, sin pisarse entre sí)"
              >
                <div className="vc-summary-text">
                  <div className="vc-summary-label">
                    <span className="vc-tecnico-icono">🔄</span> Programar auto
                  </div>
                </div>
              </button>
              {confirmProgramarAuto && (
                <div className="vc-alarm-dropdown vc-dropdown-centered">
                  <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
                    ⚠ Esto va a recalcular y SUSTITUIR los horarios de TODAS las líneas, en las 4 estaciones, según los
                    parámetros de abajo. ¿Continuar?
                  </p>
                  <div className="vc-reset-confirm">
                    <button
                      className="vc-reset-confirm-yes"
                      onClick={() => {
                        calcularProgramacionAutomaticaGlobal();
                        setConfirmProgramarAuto(false);
                      }}
                    >
                      sí, programar
                    </button>
                    <button className="vc-reset-confirm-no" onClick={() => setConfirmProgramarAuto(false)}>
                      cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row">
              <button
                className="vc-summary-card vc-summary-card-btn vc-summary-card-compact vc-tecnico-btn-alto vc-tecnico-btn-bajo"
                onClick={() => {
                  setTemporadaListado(getSeasonForDate(now));
                  setPantallaActiva("listado");
                }}
                title="Ver listado de horarios de todas las líneas (con las que se cruzan entre sí, huecos libres, y total de actuaciones por línea)"
              >
                <div className="vc-summary-text">
                  <div className="vc-summary-label">
                    <span className="vc-tecnico-icono">📋</span> Ver listado
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}
        {resumenProgramacionGlobal && (
          <div className="vc-resumen-programacion-global">
            ✅ {resumenProgramacionGlobal.lineasProgramadas} línea(s) programada(s) automáticamente, sin pisarse entre ellas.
            {resumenProgramacionGlobal.sinSuperficie > 0 &&
              ` ${resumenProgramacionGlobal.sinSuperficie} línea(s) sin superficie asignada en el Plano — se han dejado tal cual.`}
            {resumenProgramacionGlobal.conflictosTotales > 0 &&
              ` ⚠ ${resumenProgramacionGlobal.conflictosTotales} tanda(s) no encontraron hueco libre del todo — revísalas a mano.`}
            <button className="vc-resumen-cerrar-btn" onClick={() => setResumenProgramacionGlobal(null)}>
              ✕
            </button>
          </div>
        )}
        {pantallaActiva === "programacion" && (
          <div className="vc-tecnico-cliente-stack" style={{ marginBottom: "1.25rem" }}>
            <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={etoDropdownRef}>
              <button
                className={showEtoConfig ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact" : "vc-summary-card vc-summary-card-btn vc-summary-card-compact"}
                onClick={() => setShowEtoConfig((v) => !v)}
              >
                <div className="vc-summary-text">
                  <div className="vc-summary-label">🌤️ Parámetros de programación</div>
                  <div className="vc-summary-value">
                    {etoSol}/{etoSemisombra}/{etoSombra} L/m²
                  </div>
                </div>
              </button>
              {showEtoConfig && (
                <div className="vc-alarm-dropdown vc-dropdown-centered">
                  <div className="vc-history-title" style={{ marginBottom: 4 }}>Parámetros para la programación automática</div>
                  <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
                    Estos valores son los que usa el botón 🔄 de arriba para calcular cuántas tandas y de cuánta duración
                    le hacen falta a cada línea, en cada estación, según su superficie y su exposición (sol/semisombra/sombra,
                    se configura en la tarjeta de cada línea).
                  </p>
                  <div className="vc-field-row">
                    <label>
                      ETo sol pleno (L/m²/día)
                      <input type="number" step="0.1" value={etoSol} onChange={(e) => setEtoSol(Number(e.target.value))} />
                    </label>
                    <label>
                      ETo semisombra (L/m²/día)
                      <input
                        type="number"
                        step="0.1"
                        value={etoSemisombra}
                        onChange={(e) => setEtoSemisombra(Number(e.target.value))}
                      />
                    </label>
                    <label>
                      ETo sombra (L/m²/día)
                      <input type="number" step="0.1" value={etoSombra} onChange={(e) => setEtoSombra(Number(e.target.value))} />
                    </label>
                  </div>
                  <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Necesidad hídrica por estación</div>
                  <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
                    El ETo de arriba es el de referencia (verano). Cada estación lo multiplica por este factor propio, para
                    reflejar que en invierno las plantas necesitan mucha menos agua que en pleno verano. Por ejemplo, un
                    factor de 0,3 en invierno significa que se riega solo el 30% de lo que se riega en verano.
                  </p>
                  <div className="vc-field-row">
                    {ESTACIONES.map((est) => (
                      <label key={est.key}>
                        {est.label} (factor sobre el ETo)
                        <input
                          type="number"
                          step="0.05"
                          min="0"
                          max="2"
                          value={factoresEstacionales[est.key]}
                          onChange={(e) =>
                            setFactoresEstacionales({ ...factoresEstacionales, [est.key]: Number(e.target.value) })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={duracionTandaDropdownRef}>
              <button
                className={
                  showDuracionTandaConfig
                    ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact"
                    : "vc-summary-card vc-summary-card-btn vc-summary-card-compact"
                }
                onClick={() => setShowDuracionTandaConfig((v) => !v)}
              >
                <div className="vc-summary-text">
                  <div className="vc-summary-label">⏱️ Duración de tanda</div>
                  <div className="vc-summary-value">{sectors.length} líneas</div>
                </div>
              </button>
              {showDuracionTandaConfig && (
                <div className="vc-alarm-dropdown vc-dropdown-centered">
                  <div className="vc-history-title" style={{ marginBottom: 4 }}>Duración de tanda por línea (minutos)</div>
                  <div className="vc-riego-log">
                    {sectors.map((s) => (
                      <div className="vc-riego-log-item" key={s.id}>
                        <span className="vc-riego-log-time">{s.name}</span>
                        <span className="vc-riego-log-stats">
                          {s.areaM2 ? `${s.areaM2} m² · ${s.exposicion || "sol"}` : "sin superficie asignada en el Plano"}
                        </span>
                        <input
                          type="number"
                          step="1"
                          min="1"
                          style={{ width: 60 }}
                          value={s.duracionTandaAuto ?? 25}
                          onChange={(e) => updateSector(s.id, { ...s, duracionTandaAuto: Number(e.target.value) })}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      {maestraCerrada && (
        <div className="vc-maestra-banner">
          <div className="vc-maestra-titulo">⛔ Electroválvula maestra cerrada — rotura antes de las electroválvulas</div>
          <p className="vc-maestra-motivo">{maestraCerrada.motivo}</p>
          <p className="vc-maestra-hora">Ocurrió: {new Date(maestraCerrada.ts).toLocaleString("es-ES")}</p>
          {!confirmRearmeMaestra ? (
            <button className="vc-maestra-rearmar" onClick={() => setConfirmRearmeMaestra(true)}>
              ✓ he revisado y reparado la avería — reabrir maestra
            </button>
          ) : (
            <div className="vc-maestra-confirm">
              <span>¿Confirmas que un técnico ha revisado y reparado la rotura? Se reabrirá la electroválvula maestra.</span>
              <button
                className="vc-maestra-confirm-yes"
                onClick={() => {
                  setMaestraCerrada(null);
                  setConfirmRearmeMaestra(false);
                }}
              >
                sí, reabrir
              </button>
              <button className="vc-maestra-confirm-no" onClick={() => setConfirmRearmeMaestra(false)}>
                cancelar
              </button>
            </div>
          )}
        </div>
      )}

      {anyActive && !presionEnRangoTrabajo && (
        <div className="vc-leak-stack">
          <div className="vc-leak-banner vc-leak-banner-pressure">
            <span>
              ℹ Hay líneas regando con la presión de red fuera del rango de trabajo ({presionBaja}–{presionAlta} bar) — actual: {pressureBar} bar. Mientras
              dure, el diagnóstico de embozo/fuga por línea queda en pausa: los emisores no entregan su caudal nominal por falta o exceso
              de presión, no por avería. Comprueba primero la presión de cabezal.
            </span>
          </div>
        </div>
      )}

      {pressureAlert && (
        <div className="vc-leak-stack">
          <div className="vc-leak-banner vc-leak-banner-pressure">
            <span>
              ⚠ Presión de red sostenidamente{" "}
              {pressureAlert.type === "sin_agua_red" ? "sin agua" : pressureAlert.type === "presion_baja" ? "baja" : "alta"} (
              {pressureAlert.value} bar durante ≥
              {pressureAlert.type === "sin_agua_red" ? presionHorasSinAgua : pressureAlert.type === "presion_baja" ? presionHorasBaja : presionHorasAlta}{" "}
              h) — no se ha aislado ninguna línea, revisar suministro/regulador.
            </span>
            <div className="vc-leak-actions">
              {tecnico.alarmas?.presion !== false && (
                <>
                  <a className="vc-leak-notify" href={buildMailtoUrl(pressureAlert, tecnico)} title="Abrir correo con el aviso ya redactado">
                    ✉ Avisar
                  </a>
                  {tecnico.telefono && (
                    <a
                      className="vc-leak-notify"
                      href={buildWhatsappUrl(pressureAlert, tecnico)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir WhatsApp con el aviso ya redactado"
                    >
                      💬 WhatsApp
                    </a>
                  )}
                </>
              )}
              <button className="vc-leak-rearm" onClick={descartarAlertaPresion}>
                Descartar aviso
              </button>
            </div>
          </div>
        </div>
      )}

      {multiLineAlert && (
        <div className="vc-leak-stack">
          <div className="vc-leak-banner vc-leak-banner-multi">
            <span>
              ⚠ {multiLineAlert.cantidad} líneas con incidencias a la vez ({multiLineAlert.lineas}) — sospecha primero de una causa
              común (presión, filtro, suministro) antes de revisar cada línea por separado.
            </span>
            <div className="vc-leak-actions">
              {tecnico.alarmas?.multiples_lineas !== false && (
                <>
                  <a className="vc-leak-notify" href={buildMailtoUrl(multiLineAlert, tecnico)} title="Abrir correo con el aviso ya redactado">
                    ✉ Avisar
                  </a>
                  {tecnico.telefono && (
                    <a
                      className="vc-leak-notify"
                      href={buildWhatsappUrl(multiLineAlert, tecnico)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir WhatsApp con el aviso ya redactado"
                    >
                      💬 WhatsApp
                    </a>
                  )}
                </>
              )}
              <button className="vc-leak-rearm" onClick={descartarAlertaMultiLinea}>
                Descartar aviso
              </button>
            </div>
          </div>
        </div>
      )}

      {fertilizerAlert && (
        <div className="vc-leak-stack">
          <div className={fertilizerAlert.type === "fertilizante_agotado" ? "vc-leak-banner" : "vc-leak-banner vc-leak-banner-pressure"}>
            <span>
              {fertilizerAlert.type === "fertilizante_agotado" ? "⚠" : "ℹ"} Depósito de fertilizante{" "}
              {fertilizerAlert.type === "fertilizante_agotado" ? "prácticamente agotado" : "bajo"} ({fertilizerLevel}%) — el riego sigue
              funcionando con agua, pero sin dosificación efectiva.
            </span>
            <div className="vc-leak-actions">
              {tecnico.alarmas?.fertilizante !== false && (
                <>
                  <a className="vc-leak-notify" href={buildMailtoUrl(fertilizerAlert, tecnico)} title="Abrir correo con el aviso ya redactado">
                    ✉ Avisar
                  </a>
                  {tecnico.telefono && (
                    <a
                      className="vc-leak-notify"
                      href={buildWhatsappUrl(fertilizerAlert, tecnico)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir WhatsApp con el aviso ya redactado"
                    >
                      💬 WhatsApp
                    </a>
                  )}
                </>
              )}
              <button className="vc-leak-rearm" onClick={rellenarFertilizante}>
                Marcar como rellenado
              </button>
            </div>
          </div>
        </div>
      )}


      {pantallaActiva === "lineas" && (
      <div className="vc-summary-row vc-summary-row-3">
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={litrosDropdownRef}>
          <button
            className="vc-summary-card vc-summary-card-narrow vc-summary-card-vertical vc-summary-card-btn"
            onClick={() => setShowLitrosChart((v) => !v)}
            title={
              historialDiarioEsReal
                ? "Acumulado de los últimos 90 días más lo que lleva hoy — pulsa para ver la gráfica"
                : "Pulsa para ver la gráfica de consumo total"
            }
          >
            <div className="vc-summary-icon-box">
              <MiniAguaIcon active={anyActive} />
            </div>
            <div className="vc-summary-text vc-summary-text-center">
              <div className="vc-summary-label">Litros T.</div>
              <div
                className="vc-summary-value vc-summary-value-sub"
                style={{ color: anyActive ? "var(--vc-flow)" : "var(--vc-text-muted)" }}
              >
                {totalLitrosHistorico} L
              </div>
            </div>
          </button>
          {showLitrosChart && (
            <div className="vc-alarm-dropdown vc-dropdown-centered">
              <div className="vc-chart-title">
                <span>Consumo total (L/día)</span>
                <span className="vc-chart-current" style={{ color: "var(--vc-flow)" }}>
                  {todayTotalLiters} L hoy
                </span>
              </div>
              <DailyBarChart data={chartConsumoReciente} color="var(--vc-brass)" unit="L" />
              <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setShowAnnualWaterHistory((v) => !v)}>
                {showAnnualWaterHistory ? "ocultar historial de 1 año" : `ver historial de 1 año (${chartConsumoDiario.length} días guardados)`}
              </button>
              {showAnnualWaterHistory && (
                <div className="vc-annual-chart-wrap">
                  <DailyBarChart
                    data={ventanaDatos(chartConsumoDiario, waterAnnualOffset, VENTANA_DIAS_HISTORICO)}
                    color="var(--vc-brass)"
                    unit="L"
                    height={280}
                    onBarClick={(entry) => setSelectedGlobalConsumoDay(entry.date || "hoy")}
                  />
                  <ChartNavBar
                    offset={waterAnnualOffset}
                    setOffset={setWaterAnnualOffset}
                    total={chartConsumoDiario.length}
                    windowSize={VENTANA_DIAS_HISTORICO}
                  />
                  {selectedGlobalConsumoDay && (
                    <div className="vc-hourly-detail">
                      <div className="vc-hourly-detail-title">
                        <span>
                          Consumo por línea —{" "}
                          {selectedGlobalConsumoDay === "hoy"
                            ? "Hoy"
                            : chartConsumoDiario.find((d) => d.date === selectedGlobalConsumoDay)?.label || selectedGlobalConsumoDay}
                        </span>
                        <button className="vc-cal-dia-cerrar-btn" onClick={() => setSelectedGlobalConsumoDay(null)}>
                          ✕
                        </button>
                      </div>
                      <DailyBarChart
                        data={sectors.map((s) => {
                          const entrada =
                            selectedGlobalConsumoDay === "hoy"
                              ? null
                              : (s.dailyConsumption || []).find((d) => d.date === selectedGlobalConsumoDay);
                          const liters =
                            selectedGlobalConsumoDay === "hoy" ? s.sensors?.litersToday || 0 : entrada ? entrada.liters : 0;
                          return { label: s.name, liters };
                        })}
                        color="var(--vc-flow)"
                        unit="L"
                        height={180}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={presionDropdownRef}>
          <button
            className="vc-summary-card vc-summary-card-narrow vc-summary-card-vertical vc-summary-card-btn"
            onClick={() => setShowPresionChart((v) => !v)}
            title="Pulsa para ver la gráfica de presión"
          >
            <div className="vc-summary-icon-box">
              <PressureGauge
                bar={pressureBar}
                umbralSinAgua={presionSinAgua}
                umbralBaja={presionBaja}
                umbralAlta={presionAlta}
                escalaMax={presionEscalaMax}
              />
            </div>
            <div className="vc-summary-text vc-summary-text-center">
              <div className="vc-summary-label">Presión red</div>
              <div
                className="vc-summary-value vc-summary-value-sub"
                style={{ color: pressureOutOfRange ? "var(--vc-red)" : "var(--vc-amber)" }}
              >
                {pressureBar} bar
              </div>
            </div>
          </button>
          {showPresionChart && (
            <div className="vc-alarm-dropdown vc-dropdown-centered">
              <div className="vc-chart-title">
                <span>Presión de red</span>
                <span className="vc-chart-current" style={{ color: pressureOutOfRange ? "var(--vc-red)" : "var(--vc-amber)" }}>
                  {pressureBar} bar
                </span>
              </div>
              {chartPresionHoraria.length > 1 ? (
                <div className="vc-chart-clip">
                  <TrendChart data={chartPresionHoraria} color="var(--vc-amber)" unit="bar" dataKey="pressure" />
                </div>
              ) : (
                <div className="vc-chart-empty">registrando datos…</div>
              )}
              <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setShowAnnualPressureHistory((v) => !v)}>
                {showAnnualPressureHistory
                  ? "ocultar historial de 1 año"
                  : `ver historial de 1 año (${chartPresionDiaria.length} días guardados)`}
              </button>
              {showAnnualPressureHistory && (
                <div className="vc-annual-chart-wrap">
                  <div className="vc-chart-clip">
                    <TrendChart
                      data={ventanaDatos(chartPresionDiaria, pressureAnnualOffset, VENTANA_DIAS_HISTORICO)}
                      color="var(--vc-amber)"
                      unit="bar"
                      dataKey="avgPressure"
                      height={280}
                    />
                  </div>
                  <ChartNavBar
                    offset={pressureAnnualOffset}
                    setOffset={setPressureAnnualOffset}
                    total={chartPresionDiaria.length}
                    windowSize={VENTANA_DIAS_HISTORICO}
                  />
                  <div className="vc-outage-log">
                    <div className="vc-outage-log-title">
                      Horas sin presión registradas (&lt;1,0 bar) — {pressureOutageLog.length}
                    </div>
                    {pressureOutageLog.length === 0 ? (
                      <div className="vc-chart-empty">sin caídas de presión registradas</div>
                    ) : (
                      pressureOutageLog.slice(0, 30).map((o, i) => (
                        <div className="vc-outage-log-item" key={i}>
                          <span>
                            {new Date(o.ts).toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short" })} ·{" "}
                            {new Date(o.ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span>{o.value} bar</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={redDropdownRef}>
          <button
            className="vc-summary-card vc-summary-card-narrow vc-summary-card-vertical vc-summary-card-btn"
            onClick={() => setShowRedHistory((v) => !v)}
            title="Electroválvula maestra: se cierra sola si hay indicio de rotura antes de las líneas. Pulsa para ver el historial."
          >
            <div className="vc-summary-icon-box">
              <MiniAguaIcon active={anyActive} danger={!!maestraCerrada} />
            </div>
            <div className="vc-summary-text vc-summary-text-center">
              <div
                className="vc-summary-value vc-estado-red-texto"
                style={{ color: maestraCerrada ? "var(--vc-red)" : anyActive ? "var(--vc-open)" : "var(--vc-text-muted)" }}
              >
                {maestraCerrada ? "MAESTRA CERRADA" : anyActive ? "regando" : "en reposo"}
              </div>
              <div
                className="vc-summary-value vc-summary-value-sub"
                style={{ color: maestraCerrada ? "var(--vc-red)" : anyActive ? "var(--vc-flow)" : "var(--vc-text-muted)" }}
              >
                {caudalGeneralMedido} L/h
              </div>
            </div>
          </button>
          {showRedHistory && (
            <div className="vc-alarm-dropdown vc-dropdown-centered">
              <div className="vc-history-title">
                Historial de la electroválvula maestra ({alarmHistory.filter((a) => a.type === "rotura_antes_electrovalvulas").length})
              </div>
              {alarmHistory.filter((a) => a.type === "rotura_antes_electrovalvulas").length === 0 ? (
                <div className="vc-history-empty">sin incidencias registradas todavía</div>
              ) : (
                <>
                  {alarmHistory
                    .filter((a) => a.type === "rotura_antes_electrovalvulas")
                    .map((a) => (
                      <div className="vc-alarm-item vc-alarm-item-detected" key={a.id}>
                        <div className="vc-alarm-item-row">
                          <span>⛔ Rotura antes de las electroválvulas — {a.detalle}</span>
                          <span>
                            {new Date(a.ts).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                    ))}
                  {!confirmBorrarHistorialRed ? (
                    <button className="vc-toggle-btn vc-annual-toggle vc-borrar-historial-btn" onClick={() => setConfirmBorrarHistorialRed(true)}>
                      🗑 borrar este historial
                    </button>
                  ) : (
                    <div className="vc-reset-confirm" style={{ marginTop: 8 }}>
                      <span>¿Borrar todo el historial de la electroválvula maestra?</span>
                      <button
                        className="vc-reset-confirm-yes"
                        onClick={() => {
                          setAlarmHistory((prev) => prev.filter((a) => a.type !== "rotura_antes_electrovalvulas"));
                          setConfirmBorrarHistorialRed(false);
                        }}
                      >
                        sí, borrar
                      </button>
                      <button className="vc-reset-confirm-no" onClick={() => setConfirmBorrarHistorialRed(false)}>
                        cancelar
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        {contadoresGenerales.map((c) => {
          const humedadFuera = c.humedad_escorrentia != null && c.humedad_escorrentia > (c.umbral_escorrentia_humedad_max ?? 70);
          return (
            <div key={c.id} className="vc-summary-card vc-summary-card-narrow vc-summary-card-vertical" title={c.nombre}>
              <div className="vc-summary-text vc-summary-text-center">
                <div className="vc-summary-value vc-estado-red-texto" style={{ color: "var(--vc-text-muted)" }}>
                  {c.nombre}
                </div>
                <div className="vc-summary-value vc-summary-value-sub">{c.caudal != null ? `${c.caudal} L/h` : "sin datos"}</div>
                {c.humedad_escorrentia != null && (
                  <div
                    className="vc-summary-value vc-summary-value-sub"
                    style={{ color: humedadFuera ? "var(--vc-amber)" : "var(--vc-text-muted)" }}
                  >
                    {humedadFuera ? "⚠ " : ""}escorrentía {c.humedad_escorrentia}%
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={fertilizerDropdownRef}>
          <button
            className={
              showFertilizerHistory
                ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-vertical vc-summary-card-narrow"
                : "vc-summary-card vc-summary-card-btn vc-summary-card-vertical vc-summary-card-narrow"
            }
            onClick={() => setShowFertilizerHistory((v) => !v)}
          >
            <div className="vc-summary-icon-box">
              <FertilizerGauge
                level={fertilizerLevel}
                consumiendo={
                  (mainSupply && !maestraCerrada && sectors.some((s) => isSectorActiveNow(s, now))) ||
                  sectors.some((s) => Number(s.sensors?.flowMeasured || 0) > 0)
                }
              />
            </div>
            <div className="vc-summary-text vc-summary-text-center">
              <div className="vc-summary-label">Fertilizante</div>
              <div
                className="vc-summary-value vc-summary-value-sub"
                style={{ color: fertilizerLevel < 5 ? "var(--vc-red)" : fertilizerLevel < 15 ? "var(--vc-amber)" : "var(--vc-violet)" }}
              >
                {fertilizerLevel}%
              </div>
            </div>
          </button>
          {showFertilizerHistory && (
            <div className="vc-alarm-dropdown vc-fertilizer-dropdown vc-dropdown-centered">
              <div className="vc-chart-title">
                <span>Consumo de fertilizante (mL/día)</span>
                <span className="vc-chart-current" style={{ color: "var(--vc-violet)" }}>
                  {fertilizerConsumedToday} mL hoy
                </span>
              </div>
              <div className="vc-chart-clip">
                <DailyBarChart data={chartFertilizanteDiario} color="var(--vc-violet)" unit="mL" dataKey="consumoML" height={140} />
              </div>
              <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setShowAnnualFertilizerHistory((v) => !v)}>
                {showAnnualFertilizerHistory
                  ? "ocultar historial de 1 año"
                  : `ver historial de 1 año (${chartFertilizanteDiario.length} días guardados)`}
              </button>
              {showAnnualFertilizerHistory && (
                <div className="vc-annual-chart-wrap">
                  <div className="vc-chart-title" style={{ marginBottom: 6 }}>
                    <span>Total consumido en este periodo</span>
                    <span className="vc-chart-current" style={{ color: "var(--vc-violet)" }}>
                      {Math.round(
                        ventanaDatos(chartFertilizanteDiario, fertilizerAnnualOffset, VENTANA_DIAS_HISTORICO).reduce(
                          (sum, d) => sum + Number(d.consumoML || 0),
                          0
                        )
                      )}{" "}
                      mL
                    </span>
                  </div>
                  <div className="vc-chart-clip">
                    <DailyBarChart
                      data={ventanaDatos(chartFertilizanteDiario, fertilizerAnnualOffset, VENTANA_DIAS_HISTORICO)}
                      color="var(--vc-violet)"
                      unit="mL"
                      dataKey="consumoML"
                      height={200}
                      onBarClick={(entry) => setSelectedFertilizerDay(entry.date || "hoy")}
                    />
                  </div>
                  <ChartNavBar
                    offset={fertilizerAnnualOffset}
                    setOffset={setFertilizerAnnualOffset}
                    total={chartFertilizanteDiario.length}
                    windowSize={VENTANA_DIAS_HISTORICO}
                  />
                  {selectedFertilizerDay &&
                    (() => {
                      const esHoyFert = selectedFertilizerDay === "hoy";
                      const diaHistFert = fertilizerHourlyHistory.find((d) => d.date === selectedFertilizerDay);
                      const diaDiarioFert = fertilizerDailyHistory.find((d) => d.date === selectedFertilizerDay);
                      const labelFert = esHoyFert ? "Hoy" : diaHistFert?.label || diaDiarioFert?.label || selectedFertilizerDay;
                      const hayDatosFert = esHoyFert || !!diaHistFert;
                      const horasFert = esHoyFert
                        ? Array.isArray(fertilizerHourlyConsumption)
                          ? fertilizerHourlyConsumption
                          : Array(24).fill(0)
                        : diaHistFert?.hours || Array(24).fill(0);
                      const horasDelDiaFert = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}h`);
                      return (
                        <div className="vc-hourly-detail">
                          <div className="vc-hourly-detail-title">
                            <span>Consumo por hora — {labelFert}</span>
                            <button className="vc-cal-dia-cerrar-btn" onClick={() => setSelectedFertilizerDay(null)}>
                              ✕
                            </button>
                          </div>
                          {hayDatosFert ? (
                            <div className="vc-chart-clip">
                              <DailyBarChart
                                data={horasDelDiaFert.map((h, i) => ({
                                  label: h,
                                  consumoML: horasFert[i],
                                  isToday: esHoyFert && i === new Date().getHours(),
                                }))}
                                color="var(--vc-flow)"
                                unit="mL"
                                dataKey="consumoML"
                                height={160}
                                todayColor="var(--vc-violet)"
                              />
                            </div>
                          ) : (
                            <div className="vc-chart-empty">
                              No hay detalle por hora guardado para este día (solo se conservan los últimos 14 días).
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  <div className="vc-chart-title" style={{ marginTop: 10 }}>
                    <span>Total consumido — histórico completo ({chartFertilizanteDiario.length} días)</span>
                    <span className="vc-chart-current" style={{ color: "var(--vc-violet)" }}>
                      {Math.round(chartFertilizanteDiario.reduce((sum, d) => sum + Number(d.consumoML || 0), 0))} mL
                    </span>
                  </div>
                </div>
              )}
              <div className="vc-fertilizer-level-row">
                <span>Nivel del depósito</span>
                <span
                  style={{ color: fertilizerLevel < 5 ? "var(--vc-red)" : fertilizerLevel < 15 ? "var(--vc-amber)" : "var(--vc-violet)" }}
                >
                  {fertilizerLevel}%
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {pantallaActiva === "ajustes" && (
      <div className="vc-summary-row vc-summary-row-full">
        <div className="vc-tecnico-cliente-stack">
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={tecnicoDropdownRef}>
          <button
            className={showTecnicoConfig ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact vc-tecnico-btn-alto" : "vc-summary-card vc-summary-card-btn vc-summary-card-compact vc-tecnico-btn-alto"}
            onClick={() => setShowTecnicoConfig((v) => !v)}
          >
            <div className="vc-summary-text">
              <div className="vc-summary-label">
                <span className="vc-tecnico-icono">👷</span> Técnico
              </div>
              <div className="vc-summary-value">{tecnico.nombre ? tecnico.nombre : "sin definir"}</div>
            </div>
          </button>
          {showTecnicoConfig && (
            <div className="vc-alarm-dropdown vc-tecnico-form vc-dropdown-centered">
              <div className="vc-history-title">Técnico de mantenimiento</div>
              <p className="vc-tecnico-hint">
                Estos datos se usan para preparar el correo o WhatsApp de cada alarma. El panel no envía avisos automáticamente: abre tu
                app de correo/WhatsApp con el mensaje ya redactado para que lo confirmes y envíes tú.
              </p>
              <label className="vc-tecnico-field">
                Nombre
                <input
                  type="text"
                  value={tecnico.nombre}
                  onChange={(e) => setTecnico({ ...tecnico, nombre: e.target.value })}
                  placeholder="Nombre del técnico"
                />
              </label>
              <label className="vc-tecnico-field">
                Teléfono / WhatsApp
                <input
                  type="text"
                  value={tecnico.telefono}
                  onChange={(e) => setTecnico({ ...tecnico, telefono: e.target.value })}
                  placeholder="+34 600 000 000"
                />
              </label>
              <label className="vc-tecnico-field">
                Email del técnico
                <input
                  type="email"
                  value={tecnico.email}
                  onChange={(e) => setTecnico({ ...tecnico, email: e.target.value })}
                  placeholder="tecnico@ejemplo.com"
                />
              </label>
              <label className="vc-tecnico-field">
                Email de avisos (si es distinto)
                <input
                  type="email"
                  value={tecnico.emailAvisos}
                  onChange={(e) => setTecnico({ ...tecnico, emailAvisos: e.target.value })}
                  placeholder="avisos@verdtical.com"
                />
              </label>
              <div className="vc-tecnico-alarmas-title">Alarmas que quieres que le lleguen</div>
              <div className="vc-tecnico-checks">
                {CATEGORIAS_ALARMA.map((c) => (
                  <label className="vc-tecnico-check" key={c.key}>
                    <input
                      type="checkbox"
                      checked={tecnico.alarmas?.[c.key] !== false}
                      onChange={(e) => setTecnico({ ...tecnico, alarmas: { ...tecnico.alarmas, [c.key]: e.target.checked } })}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={clienteDropdownRef}>
          <button
            className={showClienteConfig ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact vc-tecnico-btn-alto" : "vc-summary-card vc-summary-card-btn vc-summary-card-compact vc-tecnico-btn-alto"}
            onClick={() => setShowClienteConfig((v) => !v)}
          >
            <div className="vc-summary-text">
              <div className="vc-summary-label">
                <span className="vc-tecnico-icono">🧑</span> Cliente
              </div>
              <div className="vc-summary-value">{cliente.nombre ? cliente.nombre : "sin definir"}</div>
            </div>
          </button>
          {showClienteConfig && (
            <div className="vc-alarm-dropdown vc-tecnico-form vc-dropdown-centered">
              <div className="vc-history-title">Cliente final</div>
              <p className="vc-tecnico-hint">
                Estos datos se usan para el informe de mantenimiento y para avisar al cliente de las alarmas que marques y de su
                arreglo posterior. El panel no envía nada automáticamente: abre tu app de correo/WhatsApp con el mensaje ya redactado
                para que lo confirmes y envíes tú.
              </p>
              <label className="vc-tecnico-field">
                Nombre
                <input
                  type="text"
                  value={cliente.nombre}
                  onChange={(e) => setCliente({ ...cliente, nombre: e.target.value })}
                  placeholder="Nombre del cliente"
                />
              </label>
              <label className="vc-tecnico-field">
                Teléfono / WhatsApp
                <input
                  type="text"
                  value={cliente.telefono}
                  onChange={(e) => setCliente({ ...cliente, telefono: e.target.value })}
                  placeholder="+34 600 000 000"
                />
              </label>
              <label className="vc-tecnico-field">
                Email del cliente
                <input
                  type="email"
                  value={cliente.email}
                  onChange={(e) => setCliente({ ...cliente, email: e.target.value })}
                  placeholder="cliente@ejemplo.com"
                />
              </label>
              <label className="vc-tecnico-field">
                Email de avisos (si es distinto)
                <input
                  type="email"
                  value={cliente.emailAvisos}
                  onChange={(e) => setCliente({ ...cliente, emailAvisos: e.target.value })}
                  placeholder="avisos@cliente.com"
                />
              </label>
              <div className="vc-tecnico-alarmas-title">Alarmas que quieres que le lleguen al cliente</div>
              <div className="vc-tecnico-checks">
                {CATEGORIAS_ALARMA.map((c) => (
                  <label className="vc-tecnico-check" key={c.key}>
                    <input
                      type="checkbox"
                      checked={cliente.alarmas?.[c.key] === true}
                      onChange={(e) => setCliente({ ...cliente, alarmas: { ...cliente.alarmas, [c.key]: e.target.checked } })}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
              <button
                className="vc-cliente-copiar-btn"
                onClick={() => {
                  const datos = JSON.stringify({ nombre: cliente.nombre, email: cliente.email, telefono: cliente.telefono, emailAvisos: cliente.emailAvisos });
                  navigator.clipboard.writeText(datos);
                  setCopiadoCliente(true);
                  setTimeout(() => setCopiadoCliente(false), 2000);
                }}
                disabled={!cliente.nombre && !cliente.email}
              >
                {copiadoCliente ? "✓ copiado" : "📋 copiar datos de cliente (para pegar en el mapa de proyectos)"}
              </button>
            </div>
          )}
        </div>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={mantenimientoDropdownRef}>
          <button
            className={
              showMantenimientoConfig
                ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact vc-tecnico-btn-alto"
                : "vc-summary-card vc-summary-card-btn vc-summary-card-compact vc-tecnico-btn-alto"
            }
            onClick={() => setShowMantenimientoConfig((v) => !v)}
          >
            <div className="vc-summary-text">
              <div className="vc-summary-label">
                <span className="vc-tecnico-icono">📅</span> Mantenimiento
              </div>
              <div className="vc-summary-value">
                {cliente.proximoMantenimiento
                  ? new Date(cliente.proximoMantenimiento).toLocaleDateString("es-ES", { day: "2-digit", month: "short" })
                  : "sin programar"}
              </div>
            </div>
          </button>
          {showMantenimientoConfig && (
            <div className="vc-alarm-dropdown vc-dropdown-centered">
              <div className="vc-history-title">Día de mantenimiento</div>
              <label className="vc-tecnico-field">
                Frecuencia de mantenimiento contratada
                <select
                  value={cliente.frecuenciaMantenimiento || ""}
                  onChange={(e) => setCliente({ ...cliente, frecuenciaMantenimiento: e.target.value })}
                >
                  <option value="">sin definir</option>
                  <option value="mensual">Mensual</option>
                  <option value="bimensual">Bimensual (cada 2 meses)</option>
                  <option value="trimestral">Trimestral (cada 3 meses)</option>
                  <option value="cuatrimestral">Cuatrimestral (cada 4 meses)</option>
                  <option value="semestral">Semestral (cada 6 meses)</option>
                </select>
              </label>
              {cliente.frecuenciaMantenimiento && (
                <div className="vc-mantenimiento-box">
                  <div className="vc-mantenimiento-fecha">
                    📅 Próximo mantenimiento:{" "}
                    <strong>
                      {cliente.proximoMantenimiento
                        ? new Date(cliente.proximoMantenimiento).toLocaleDateString("es-ES", {
                            weekday: "long",
                            day: "2-digit",
                            month: "long",
                            year: "numeric",
                          })
                        : "sin programar todavía"}
                    </strong>
                  </div>
                  {!confirmMantenimientoRealizado ? (
                    <button className="vc-toggle-btn vc-annual-toggle" onClick={() => setConfirmMantenimientoRealizado(true)}>
                      ✓ mantenimiento realizado hoy
                    </button>
                  ) : (
                    <div className="vc-reset-confirm">
                      <span>¿Confirmas que has hecho hoy el mantenimiento? Se calculará la próxima fecha automáticamente.</span>
                      <button
                        className="vc-reset-confirm-yes"
                        onClick={() => {
                          const hoy = new Date();
                          const proxima = calcularProximoMantenimiento(hoy, cliente.frecuenciaMantenimiento);
                          setCliente({
                            ...cliente,
                            ultimoMantenimiento: hoy.toISOString(),
                            proximoMantenimiento: proxima.toISOString(),
                          });
                          setConfirmMantenimientoRealizado(false);
                        }}
                      >
                        sí, confirmar
                      </button>
                      <button className="vc-reset-confirm-no" onClick={() => setConfirmMantenimientoRealizado(false)}>
                        cancelar
                      </button>
                    </div>
                  )}
                  <p className="vc-tecnico-hint" style={{ marginTop: 6, marginBottom: 0 }}>
                    La fecha evita automáticamente fines de semana y festivos nacionales de España (no incluye festivos
                    autonómicos ni locales).
                  </p>
                  {cliente.proximoMantenimiento && (
                    <>
                      <button
                        className="vc-toggle-btn vc-annual-toggle"
                        onClick={() => setShowCalendarioMantenimiento((v) => !v)}
                        style={{ marginTop: 8 }}
                      >
                        {showCalendarioMantenimiento ? "ocultar calendario del año" : "📆 ver calendario del año"}
                      </button>
                      {showCalendarioMantenimiento &&
                        (() => {
                          const fechas = fechasMantenimientoDelAnio(new Date(cliente.proximoMantenimiento), cliente.frecuenciaMantenimiento);
                          const anio = new Date().getFullYear();
                          const diasPorMes = {};
                          fechas.forEach((f) => {
                            const m = f.getMonth();
                            if (!diasPorMes[m]) diasPorMes[m] = [];
                            diasPorMes[m].push(f.getDate());
                          });
                          return (
                            <div className="vc-mini-cal-anio">
                              <div className="vc-history-title" style={{ marginTop: 8 }}>
                                Mantenimientos programados en {anio} ({fechas.length})
                              </div>
                              <div className="vc-mini-cal-grid-meses">
                                {Array.from({ length: 12 }, (_, m) => (
                                  <MiniCalendarMes key={m} anio={anio} mes={m} diasMarcados={diasPorMes[m] || []} />
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row">
          <button
            className="vc-summary-card vc-summary-card-btn vc-summary-card-compact vc-tecnico-btn-alto"
            onClick={() => {
              setPantallaActiva("informe");
              // El lienzo todavía no existe en el DOM en este instante (la
              // pantalla acaba de pedirse abrir), así que esperamos un
              // momento antes de prepararlo: en blanco, o con la última
              // firma guardada si ya había una.
              setTimeout(() => {
                const canvas = firmaCanvasRef.current;
                if (canvas) {
                  const ctx = canvas.getContext("2d");
                  ctx.clearRect(0, 0, canvas.width, canvas.height);
                  ctx.fillStyle = "#ffffff";
                  ctx.fillRect(0, 0, canvas.width, canvas.height);
                  if (firmaDataUrl) {
                    const img = new Image();
                    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    img.src = firmaDataUrl;
                  }
                }
                const canvasCliente = firmaClienteCanvasRef.current;
                if (canvasCliente) {
                  const ctxCliente = canvasCliente.getContext("2d");
                  ctxCliente.clearRect(0, 0, canvasCliente.width, canvasCliente.height);
                  ctxCliente.fillStyle = "#ffffff";
                  ctxCliente.fillRect(0, 0, canvasCliente.width, canvasCliente.height);
                  if (firmaClienteDataUrl) {
                    const imgCliente = new Image();
                    imgCliente.onload = () => ctxCliente.drawImage(imgCliente, 0, 0, canvasCliente.width, canvasCliente.height);
                    imgCliente.src = firmaClienteDataUrl;
                  }
                }
              }, 50);
            }}
          >
            <div className="vc-summary-text">
              <div className="vc-summary-label">
                <span className="vc-tecnico-icono">✍️</span> Informe y firma
              </div>
              <div className="vc-summary-value">{firmaFecha ? "firmado" : "sin firmar"}</div>
            </div>
          </button>
        </div>
        </div>
      </div>
      )}

      {pantallaActiva === "programacion" && (
      <div className="vc-alarm-dropdown-wrap" style={{ marginBottom: "1.25rem" }} ref={balanceHidricoDropdownRef}>
        <button
          className={showBalanceHidricoConfig ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact" : "vc-summary-card vc-summary-card-btn vc-summary-card-compact"}
          onClick={() => setShowBalanceHidricoConfig((v) => !v)}
        >
          <div className="vc-summary-text">
            <div className="vc-summary-label">🌿 Balance hídrico y CO₂</div>
            <div className="vc-summary-value">WUE {wueGramosPorLitro} g/L</div>
          </div>
        </button>
        {showBalanceHidricoConfig && (
          <div className="vc-alarm-dropdown vc-dropdown-centered">
            <div className="vc-history-title" style={{ marginBottom: 4 }}>Balance hídrico estimado</div>
            <p className="vc-tecnico-hint" style={{ margin: 0 }}>
              Compara el agua que realmente se ha regado hoy con la que las plantas necesitarían solo por
              evapotranspiración, calculada línea a línea según su superficie y su exposición real (sol,
              semisombra o sombra) — configúralas en la pestaña Plano. La diferencia es una estimación de
              escorrentía o pérdida de agua (o de riego insuficiente, si sale negativa) — no un dato medido con
              sensores de humedad de suelo, así que tómalo como orientativo. Los valores de ETo se ajustan en 📅
              Programación → 🌤️ Parámetros de programación, y el umbral de aviso en 🔔 Configuración de alarmas.
            </p>
                <p className="vc-tecnico-hint">
                  Este mismo cálculo se hace también línea a línea: si una línea concreta se desvía de su necesidad teórica más de
                  este % (por exceso = posible escorrentía, o por defecto = posible riego insuficiente), aparecerá un aviso en su
                  propia tarjeta, para identificar rápido cuál está mal ajustada. Se compara siempre con el día de AYER (ya
                  completo), no con hoy — así no sale un falso aviso de déficit mientras el riego de hoy todavía está en marcha.
                </p>
                {(() => {
                  const etoPorExposicion = { sol: etoSol, semisombra: etoSemisombra, sombra: etoSombra };
                  const superficieTotal = sectors.reduce((sum, s) => sum + Number(s.areaM2 || 0), 0);
                  const consumoTeorico =
                    Math.round(
                      sectors.reduce((sum, s) => sum + Number(s.areaM2 || 0) * (etoPorExposicion[s.exposicion] ?? etoSol), 0) * 10
                    ) / 10;
                  const consumosAyer = sectors.map((s) => consumoDeAyer(s, now));
                  const hayDatosDeAyer = consumosAyer.some((v) => v !== null);
                  const consumoReal = Math.round(consumosAyer.reduce((sum, v) => sum + (v || 0), 0) * 10) / 10;
                  const diferencia = Math.round((consumoReal - consumoTeorico) * 10) / 10;
                  if (!hayDatosDeAyer) {
                    return (
                      <div className="vc-balance-resultados">
                        <div className="vc-balance-stat" style={{ gridColumn: "1 / -1" }}>
                          <div className="vc-balance-stat-label">Todavía no hay un día completo de histórico — vuelve mañana</div>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div className="vc-balance-resultados">
                      <div className="vc-balance-stat">
                        <div className="vc-balance-stat-label">Superficie total ({superficieTotal.toFixed(1)} m²)</div>
                        <div className="vc-balance-stat-value">{consumoTeorico} L</div>
                        <div className="vc-balance-stat-label" style={{ marginTop: 2 }}>necesidad teórica / día</div>
                      </div>
                      <div className="vc-balance-stat">
                        <div className="vc-balance-stat-label">Regado real AYER</div>
                        <div className="vc-balance-stat-value">{consumoReal} L</div>
                      </div>
                      <div className="vc-balance-stat">
                        <div className="vc-balance-stat-label">
                          {diferencia >= 0 ? "Posible escorrentía" : "Posible déficit de riego"}
                        </div>
                        <div
                          className="vc-balance-stat-value"
                          style={{ color: diferencia >= 0 ? "var(--vc-amber)" : "var(--vc-red)" }}
                        >
                          {diferencia >= 0 ? "+" : ""}
                          {diferencia} L
                        </div>
                      </div>
                      <div className="vc-balance-stat vc-balance-stat-co2">
                        <div className="vc-balance-stat-label">CO₂ estimado capturado / día</div>
                        <div className="vc-balance-stat-value">{Math.round(((consumoReal * wueGramosPorLitro * 0.45 * 3.667) / 1000) * 100) / 100} kg</div>
                      </div>
                    </div>
                  );
                })()}
                <div className="vc-field-row" style={{ marginTop: 12 }}>
                  <label>
                    Eficiencia hídrica de la vegetación — WUE (g materia seca / L agua)
                    <input
                      type="number"
                      step="0.1"
                      value={wueGramosPorLitro}
                      onChange={(e) => setWueGramosPorLitro(Number(e.target.value))}
                    />
                  </label>
                </div>
                <p className="vc-tecnico-hint">
                  ⚠ El CO₂ es una ESTIMACIÓN muy orientativa, no una medición certificable: se calcula asumiendo que el ~45% de la
                  materia seca producida es carbono, y que cada gramo de carbono equivale a 3,67 g de CO₂. La eficiencia hídrica
                  (WUE) real varía enormemente según la especie concreta de cada planta (de 1 a más de 10 g/L) — el valor de arriba
                  es un promedio genérico de vegetación ornamental, ajústalo si conoces mejor las especies de tu instalación.
                </p>
          </div>
        )}
      </div>
      )}

      {pantallaActiva === "programacion" && (
      <div className="vc-alarm-dropdown-wrap" style={{ marginBottom: "1.25rem" }} ref={alarmasGlobalesDropdownRef}>
        <button
          className={
            showAlarmasGlobalesConfig
              ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact"
              : "vc-summary-card vc-summary-card-btn vc-summary-card-compact"
          }
          onClick={() => setShowAlarmasGlobalesConfig((v) => !v)}
        >
          <div className="vc-summary-text">
            <div className="vc-summary-label">🔔 Configuración de alarmas</div>
            <div className="vc-summary-value">
              {presionSinAgua}/{presionBaja}/{presionAlta} bar · Fert. {fertilizanteUmbralBajo}%/{fertilizanteUmbralAgotado}% ·{" "}
              {multiplesLineasUmbral} líneas
            </div>
          </div>
        </button>
        {showAlarmasGlobalesConfig && (
          <div className="vc-alarm-dropdown vc-dropdown-centered">
            <div className="vc-history-title" style={{ marginBottom: 4 }}>Presión de red</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              Definen los tramos de color del manómetro (rojo/ámbar/azul) y cuándo se considera que la presión está fuera
              de rango. Por debajo del primer valor: sin agua; entre el primero y el segundo: presión baja; entre el
              segundo y el tercero: correcta; por encima del tercero: presión alta. La alarma solo salta si se mantiene
              fuera de rango de forma continuada, durante las horas indicadas (no ante una caída puntual pasajera).
            </p>
            <div className="vc-field-row">
              <label>
                Sin agua por debajo de (bar)
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={presionSinAgua}
                  onChange={(e) => setPresionSinAgua(Number(e.target.value))}
                />
              </label>
              <label>
                Horas sostenidas — sin agua
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  value={presionHorasSinAgua}
                  onChange={(e) => setPresionHorasSinAgua(Number(e.target.value))}
                />
              </label>
              <label>
                Presión baja por debajo de (bar)
                <input type="number" step="0.1" min="0" value={presionBaja} onChange={(e) => setPresionBaja(Number(e.target.value))} />
              </label>
              <label>
                Horas sostenidas — presión baja
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={presionHorasBaja}
                  onChange={(e) => setPresionHorasBaja(Number(e.target.value))}
                />
              </label>
              <label>
                Presión alta por encima de (bar)
                <input type="number" step="0.1" min="0" value={presionAlta} onChange={(e) => setPresionAlta(Number(e.target.value))} />
              </label>
              <label>
                Horas sostenidas — presión alta
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={presionHorasAlta}
                  onChange={(e) => setPresionHorasAlta(Number(e.target.value))}
                />
              </label>
              <label>
                Tope de la escala del manómetro (bar)
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  value={presionEscalaMax}
                  onChange={(e) => setPresionEscalaMax(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Rotura antes del colector</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              A partir de cuántos L/h que ninguna línea explica (y durante cuánto tiempo sostenido) se cierra la
              electroválvula maestra por indicio de rotura.
            </p>
            <div className="vc-field-row">
              <label>
                Caudal no explicado (L/h)
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={roturaColectorLitrosHora}
                  onChange={(e) => setRoturaColectorLitrosHora(Number(e.target.value))}
                />
              </label>
              <label>
                Horas sostenidas antes de cerrar la maestra
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={roturaColectorHorasSostenidas}
                  onChange={(e) => setRoturaColectorHorasSostenidas(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Corte de corriente y batería del PLC</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              Cuánto dura la batería de respaldo desde el 100% hasta agotarse del todo, y a partir de qué nivel se avisa
              de "batería baja" para dar tiempo a reaccionar antes de perder los datos por completo.
            </p>
            <div className="vc-field-row">
              <label>
                Autonomía de la batería (horas, 100%→0%)
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  value={bateriaAutonomiaHoras}
                  onChange={(e) => setBateriaAutonomiaHoras(Number(e.target.value))}
                />
              </label>
              <label>
                Avisar de batería baja por debajo de (%)
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="99"
                  value={bateriaUmbralBaja}
                  onChange={(e) => setBateriaUmbralBaja(Number(e.target.value))}
                />
              </label>
              <label>
                Nivel actual de la batería (%)
                <input type="number" step="1" min="0" max="100" value={bateriaPlcNivel} readOnly disabled />
              </label>
            </div>
            <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Fuga leve (goteo) y embozo</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              Cuánto tiempo sostenido hace falta para avisar de un posible goteo o de un posible embozo en cualquier
              línea. Los porcentajes de caudal que definen cada caso siguen ajustándose por línea, dentro de cada tarjeta.
            </p>
            <div className="vc-field-row">
              <label>
                Horas sostenidas — fuga leve
                <input
                  type="number"
                  step="0.25"
                  min="0.25"
                  value={fugaLeveHorasSostenidas}
                  onChange={(e) => setFugaLeveHorasSostenidas(Number(e.target.value))}
                />
              </label>
              <label>
                Horas sostenidas — embozo
                <input
                  type="number"
                  step="0.25"
                  min="0.25"
                  value={embozoHorasSostenidas}
                  onChange={(e) => setEmbozoHorasSostenidas(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Fertilizante</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              Tamaño del depósito y dosis inyectada por litro de agua (para calcular el consumo), y a partir de qué nivel
              se avisa de "nivel bajo" y de "prácticamente agotado".
            </p>
            <div className="vc-field-row">
              <label>
                Tamaño del depósito (L)
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={fertilizerTanqueL}
                  onChange={(e) => setFertilizerTanqueL(Number(e.target.value))}
                />
              </label>
              <label>
                Dosis (mL de fertilizante por litro de agua)
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={fertilizerDosisMlPorLitro}
                  onChange={(e) => setFertilizerDosisMlPorLitro(Number(e.target.value))}
                />
              </label>
              <label>
                Nivel bajo por debajo de (%)
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="100"
                  value={fertilizanteUmbralBajo}
                  onChange={(e) => setFertilizanteUmbralBajo(Number(e.target.value))}
                />
              </label>
              <label>
                Prácticamente agotado por debajo de (%)
                <input
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  value={fertilizanteUmbralAgotado}
                  onChange={(e) => setFertilizanteUmbralAgotado(Number(e.target.value))}
                />
              </label>
              <label>
                Horas sostenidas antes de dar la alarma
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  value={fertilizanteHorasSostenidas}
                  onChange={(e) => setFertilizanteHorasSostenidas(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Balance hídrico por línea</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              Si una línea se desvía de su necesidad teórica (calculada por evapotranspiración, configurada en 📅
              Programación → 🌤️ Parámetros de programación) más de este porcentaje, aparece un aviso en su propia
              tarjeta — por exceso, posible escorrentía; por defecto, posible riego insuficiente. Se compara siempre con
              el día de ayer, ya completo.
            </p>
            <div className="vc-field-row">
              <label>
                Umbral de aviso por línea (%)
                <input
                  type="number"
                  step="1"
                  value={umbralBalanceHidrico}
                  onChange={(e) => setUmbralBalanceHidrico(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Varias líneas a la vez</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              A partir de cuántas líneas con alguna incidencia activa a la vez se avisa de "varias líneas" — señal de una
              posible causa común (presión, filtro, suministro) en vez de averías independientes.
            </p>
            <div className="vc-field-row">
              <label>
                Líneas simultáneas para avisar
                <input
                  type="number"
                  step="1"
                  min="2"
                  value={multiplesLineasUmbral}
                  onChange={(e) => setMultiplesLineasUmbral(Number(e.target.value))}
                />
              </label>
              <label>
                Horas sostenidas antes de dar la alarma
                <input
                  type="number"
                  step="0.25"
                  min="0.25"
                  value={multiplesLineasHorasSostenidas}
                  onChange={(e) => setMultiplesLineasHorasSostenidas(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Alarmas activas en esta instalación</div>
            <p className="vc-tecnico-hint" style={{ marginTop: 0 }}>
              Desmarca un tipo de alarma que en esta instalación en concreto nunca se pueda arreglar (por ejemplo, una
              línea sin sonda de humedad instalada) — así deja de saltar para siempre sin remedio posible. Afecta solo a
              esta instalación, no a las demás.
            </p>
            <div className="vc-tecnico-checks">
              {CATEGORIAS_ALARMA.map((c) => (
                <label className="vc-tecnico-check" key={c.key}>
                  <input
                    type="checkbox"
                    checked={alarmasInstalacion?.[c.key] !== false}
                    onChange={(e) =>
                      setAlarmasInstalacion({ ...alarmasInstalacion, [c.key]: e.target.checked })
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
            <button className="vc-cliente-save-btn" style={{ marginTop: 8 }} onClick={guardarAlarmasInstalacion} disabled={guardandoAlarmasInstalacion}>
              {guardandoAlarmasInstalacion ? "guardando…" : "guardar en el servidor"}
            </button>
            {avisoAlarmasInstalacion && (
              <p className="vc-tecnico-hint" style={{ marginTop: 6, color: avisoAlarmasInstalacion.startsWith("guardado") ? "var(--vc-open)" : "var(--vc-red)" }}>
                {avisoAlarmasInstalacion}
              </p>
            )}
            <p className="vc-tecnico-hint" style={{ marginTop: 14, marginBottom: 0 }}>
              Las alarmas de humedad, CE, temperatura, embozo y fugas se configuran por línea (dentro de cada tarjeta, en
              la pestaña 💧 Líneas), ya que cada línea puede necesitar valores distintos.
            </p>
          </div>
        )}
      </div>
      )}

        {pantallaActiva === "programacion" && (
        <div className="vc-tecnico-cliente-stack" style={{ marginBottom: "1.25rem" }}>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={alarmDropdownRef}>
          <button
            className={showAlarmHistory ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact" : "vc-summary-card vc-summary-card-btn vc-summary-card-compact"}
            onClick={() => setShowAlarmHistory((v) => !v)}
          >
            <div className="vc-summary-text">
              <div className="vc-summary-label">🔔 Alarmas</div>
              <div className="vc-summary-value">{alarmHistory.length} registradas</div>
            </div>
          </button>
          {showAlarmHistory && (
            <div className="vc-alarm-dropdown vc-dropdown-centered">
              <div className="vc-history-title-row">
                <div className="vc-history-title">Historial de alarmas ({alarmHistory.length})</div>
                {!confirmReset ? (
                  <button className="vc-icon-only-btn" onClick={() => setConfirmReset(true)} title="Borrar historial de alarmas">
                    🗑
                  </button>
                ) : (
                  <div className="vc-reset-confirm">
                    <span>¿Borrar el historial de alarmas?</span>
                    <button className="vc-reset-confirm-yes" onClick={reiniciarPanel}>
                      sí, borrar
                    </button>
                    <button className="vc-reset-confirm-no" onClick={() => setConfirmReset(false)}>
                      cancelar
                    </button>
                  </div>
                )}
              </div>
              {alarmHistory.length === 0 ? (
                <div className="vc-history-empty">sin alarmas registradas todavía</div>
              ) : (
                alarmHistory.map((a) => {
                  const esResuelta = a.type === "fuga_rearmada" || a.type === "fallo_electrico_resuelto";
                  const { titulo } = textoAlarma(a);
                  let detalle = "";
                  if (a.flowMeasured !== undefined && a.nominalFlow !== undefined) {
                    detalle = ` (${a.flowMeasured} L/h, esperado ${a.nominalFlow} L/h)`;
                  } else if (a.valor !== undefined) {
                    detalle = ` (${a.valor}, rango ${a.min}–${a.max})`;
                  } else if (a.value !== undefined) {
                    detalle = ` (${a.value} bar)`;
                  }
                  return (
                    <div className={esResuelta ? "vc-alarm-item vc-alarm-item-resolved" : "vc-alarm-item vc-alarm-item-detected"} key={a.id}>
                      <div className="vc-alarm-item-row">
                        <span>
                          {esResuelta ? "✓" : "⚠"} {titulo} ·{" "}
                          <span className="vc-alarm-line-name">{a.lineName}</span>
                          {detalle}
                        </span>
                        <span>
                          {new Date(a.ts).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <div className="vc-alarm-item-actions">
                        {debeNotificar(a, tecnico) ? (
                          <>
                            <a href={buildMailtoUrl(a, tecnico)} className="vc-alarm-notify-link">
                              ✉ técnico
                            </a>
                            {tecnico.telefono && (
                              <a
                                href={buildWhatsappUrl(a, tecnico)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="vc-alarm-notify-link"
                              >
                                💬 técnico
                              </a>
                            )}
                          </>
                        ) : (
                          <span className="vc-alarm-notify-off">técnico: desactivado</span>
                        )}
                        {debeNotificar(a, cliente) && cliente.email ? (
                          <>
                            <a href={buildMailtoUrl(a, cliente)} className="vc-alarm-notify-link vc-alarm-notify-link-cliente">
                              ✉ cliente
                            </a>
                            {cliente.telefono && (
                              <a
                                href={buildWhatsappUrl(a, cliente)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="vc-alarm-notify-link vc-alarm-notify-link-cliente"
                              >
                                💬 cliente
                              </a>
                            )}
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={activityDropdownRef}>
          <button
            className={showActivityLog ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact" : "vc-summary-card vc-summary-card-btn vc-summary-card-compact"}
            onClick={() => setShowActivityLog((v) => !v)}
          >
            <div className="vc-summary-text">
              <div className="vc-summary-label">📝 Actividad</div>
              <div className="vc-summary-value">{history.length} eventos</div>
            </div>
          </button>
          {showActivityLog && (
            <div className="vc-alarm-dropdown vc-dropdown-centered">
              <div className="vc-history-title-row">
                <div className="vc-history-title">Registro de actividad</div>
                {!confirmBorrarActividad ? (
                  <button className="vc-icon-only-btn" onClick={() => setConfirmBorrarActividad(true)} title="Borrar registro de actividad">
                    🗑
                  </button>
                ) : (
                  <div className="vc-reset-confirm">
                    <span>¿Borrar el registro de actividad?</span>
                    <button className="vc-reset-confirm-yes" onClick={borrarActividad}>
                      sí, borrar
                    </button>
                    <button className="vc-reset-confirm-no" onClick={() => setConfirmBorrarActividad(false)}>
                      cancelar
                    </button>
                  </div>
                )}
              </div>
              {history.length === 0 ? (
                <div className="vc-history-empty">sin eventos registrados todavía</div>
              ) : (
                history.map((h, i) => (
                  <div className="vc-history-item" key={i}>
                    <span>{h.text}</span>
                    <span>
                      {new Date(h.ts).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div className="vc-alarm-dropdown-wrap vc-dropdown-wrap-row" ref={pruebasDropdownRef}>
          <button
            className={showPruebasBox ? "vc-summary-card vc-summary-card-btn vc-summary-card-on vc-summary-card-compact" : "vc-summary-card vc-summary-card-btn vc-summary-card-compact"}
            onClick={() => setShowPruebasBox((v) => !v)}
          >
            <div className="vc-summary-text">
              <div className="vc-summary-label">🧪 Probar alarmas</div>
              <div className="vc-summary-value">simular averías</div>
            </div>
          </button>
          {showPruebasBox && (
          <div className="vc-alarm-dropdown vc-dropdown-centered vc-test-box">
            <p className="vc-tecnico-hint vc-pruebas-aviso">
              ⚠ Antes de usar estos botones, configura primero todos los datos reales de tu instalación (umbrales de
              alarmas, superficie y difusores de cada línea, técnico, cliente, fertilizante...). Estos botones simulan
              averías directamente, sin pasar por los valores configurados — sirven para comprobar que cada aviso se ve
              y se envía bien, no para calcular nada.
            </p>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (maestraCerrada) return;
                const motivoTexto =
                  "🧪 PRUEBA manual — no es una avería real. El caudalímetro general marcaría agua que ninguna línea explica, indicio de rotura antes de las electroválvulas.";
                setMaestraCerrada({ motivo: motivoTexto, ts: new Date().toISOString() });
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-maestra-${Date.now()}`,
                      ts: new Date().toISOString(),
                      lineId: null,
                      lineName: "Sistema general",
                      type: "rotura_antes_electrovalvulas",
                      detalle: motivoTexto,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: rotura antes de las electroválvulas (cierra la maestra)"
            >
              💧⛔
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length === 0) return;
                const linea = sectors.find((s) => !s.blockedByLeak) || sectors[0];
                if (!linea || linea.blockedByLeak) return;
                const nominalFlow = Number(linea.emitters || 0) * Number(linea.emitterFlow || 0) || 100;
                const flowMeasured = Math.round(nominalFlow * 1.6);
                setSectors((prev) => prev.map((s) => (s.id === linea.id ? { ...s, blockedByLeak: true } : s)));
                setLeakAlerts((prev) => [
                  ...prev,
                  { lineId: linea.id, lineName: linea.name, ts: new Date().toISOString(), flowMeasured, nominalFlow },
                ]);
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-${Date.now()}-${linea.id}`,
                      ts: new Date().toISOString(),
                      lineId: linea.id,
                      lineName: linea.name,
                      type: "fuga_grave",
                      flowMeasured,
                      nominalFlow,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: fuga grave en una línea (aísla su electroválvula)"
            >
              💧⚠
            </button>
            <button
              className={plcSinCorriente ? "vc-icon-only-btn vc-icon-only-btn-on" : "vc-icon-only-btn"}
              onClick={() => {
                const nuevoEstado = !plcSinCorriente;
                setPlcSinCorriente(nuevoEstado);
                if (nuevoEstado) {
                  setMainSupply(false);
                  setAlarmHistory((prev) =>
                    [
                      { id: `alarm-plc-${Date.now()}`, ts: new Date().toISOString(), lineId: null, lineName: "Sistema general", type: "corte_corriente_plc" },
                      ...prev,
                    ].slice(0, MAX_ALARM_LOG)
                  );
                }
              }}
              title={
                plcSinCorriente
                  ? "🧪 Pulsa de nuevo para simular que ha vuelto la corriente (la batería se recarga)"
                  : "🧪 Probar: corte de corriente en el PLC (apaga el sistema; los sensores siguen mientras dure la batería)"
              }
            >
              ⚡🔌
            </button>
            <button
              className={simulacionBateriaAgotada ? "vc-icon-only-btn vc-icon-only-btn-on" : "vc-icon-only-btn"}
              onClick={() => setSimulacionBateriaAgotada((v) => !v)}
              title={
                simulacionBateriaAgotada
                  ? "🧪 Pulsa de nuevo para simular que vuelven los datos (batería recargada)"
                  : "🧪 Probar: batería agotada — sin datos en absoluto"
              }
            >
              🔋⚠
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                setBateriaPlcNivel(Math.max(0, bateriaUmbralBaja - 1));
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-bateria-${Date.now()}`,
                      ts: new Date().toISOString(),
                      lineId: null,
                      lineName: "Batería del PLC",
                      type: "bateria_baja",
                      value: Math.max(0, bateriaUmbralBaja - 1),
                      umbral: bateriaUmbralBaja,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: batería del PLC baja (por debajo del umbral configurado)"
            >
              🔋📉
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length === 0) return;
                const linea = sectors.find((s) => !s.blockedByFault) || sectors[0];
                setSectors((prev) => prev.map((s) => (s.id === linea.id ? { ...s, blockedByFault: true } : s)));
                setAlarmHistory((prev) =>
                  [
                    { id: `alarm-${Date.now()}-${linea.id}`, ts: new Date().toISOString(), lineId: linea.id, lineName: linea.name, type: "fallo_electrico" },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: fallo eléctrico de electroválvula (no responde, sin caudal)"
            >
              ⚡🚫
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length === 0) return;
                const linea = sectors[0];
                const nominalFlow = Number(linea.emitters || 0) * Number(linea.emitterFlow || 0) || 100;
                const flowMeasured = Math.round(nominalFlow * 1.3);
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-${Date.now()}-${linea.id}`,
                      ts: new Date().toISOString(),
                      lineId: linea.id,
                      lineName: linea.name,
                      type: "fuga_leve",
                      flowMeasured,
                      nominalFlow,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: fuga leve (goteo, entre 115% y 150% del caudal nominal)"
            >
              💧🔸
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length === 0) return;
                const linea = sectors[0];
                const nominalFlow = Number(linea.emitters || 0) * Number(linea.emitterFlow || 0) || 100;
                const flowMeasured = Math.round(nominalFlow * 0.6);
                setSectors((prev) => prev.map((s) => (s.id === linea.id ? { ...s, clogFlag: true } : s)));
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-${Date.now()}-${linea.id}`,
                      ts: new Date().toISOString(),
                      lineId: linea.id,
                      lineName: linea.name,
                      type: "embozo",
                      flowMeasured,
                      nominalFlow,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: posible embozo (caudal por debajo del 85% del nominal)"
            >
              🚱
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length === 0) return;
                const linea = sectors[0];
                setSectors((prev) => prev.map((s) => (s.id === linea.id ? { ...s, humidityFlag: true } : s)));
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-${Date.now()}-${linea.id}`,
                      ts: new Date().toISOString(),
                      lineId: linea.id,
                      lineName: linea.name,
                      type: "humedad_fuera_rango",
                      valor: 15,
                      min: linea.thresholds?.humidityMin ?? 30,
                      max: linea.thresholds?.humidityMax ?? 65,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: humedad de sustrato fuera de rango"
            >
              💧📉
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length === 0) return;
                const linea = sectors[0];
                setSectors((prev) => prev.map((s) => (s.id === linea.id ? { ...s, ecFlag: true } : s)));
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-${Date.now()}-${linea.id}`,
                      ts: new Date().toISOString(),
                      lineId: linea.id,
                      lineName: linea.name,
                      type: "ec_fuera_rango",
                      valor: 3.2,
                      min: linea.thresholds?.ecMin ?? 1.2,
                      max: linea.thresholds?.ecMax ?? 2.4,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: conductividad (CE) fuera de rango"
            >
              🧂
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length === 0) return;
                const linea = sectors[0];
                setSectors((prev) => prev.map((s) => (s.id === linea.id ? { ...s, temperatureFlag: true } : s)));
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-${Date.now()}-${linea.id}`,
                      ts: new Date().toISOString(),
                      lineId: linea.id,
                      lineName: linea.name,
                      type: "temperatura_fuera_rango",
                      valor: 42,
                      min: linea.thresholds?.temperatureMin ?? 2,
                      max: linea.thresholds?.temperatureMax ?? 40,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: temperatura fuera de rango"
            >
              🌡️⚠
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                if (!sectors || sectors.length < 2) return;
                const nombres = sectors.slice(0, 3).map((s) => s.name);
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-multi-${Date.now()}`,
                      ts: new Date().toISOString(),
                      lineId: null,
                      lineName: "Varias líneas",
                      type: "multiples_lineas",
                      cantidad: nombres.length,
                      lineas: nombres.join(", "),
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: varias líneas con incidencias a la vez"
            >
              🔀⚠
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                setAlarmHistory((prev) =>
                  [
                    { id: `alarm-fert-${Date.now()}`, ts: new Date().toISOString(), lineId: null, lineName: "Depósito fertilizante", type: "fertilizante_bajo", value: 12 },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: nivel de fertilizante bajo (por debajo del 15%)"
            >
              🧪📉
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-sinagua-${Date.now()}`,
                      ts: new Date().toISOString(),
                      lineId: null,
                      lineName: "Red / suministro general",
                      type: "sin_agua_red",
                      value: Math.max(0, presionSinAgua - 0.2),
                      umbralSinAgua: presionSinAgua,
                      umbralBaja: presionBaja,
                      umbralAlta: presionAlta,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: sin agua en la red (por debajo del umbral de sin agua)"
            >
              🚱💧
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-presion-baja-${Date.now()}`,
                      ts: new Date().toISOString(),
                      lineId: null,
                      lineName: "Red / suministro general",
                      type: "presion_baja",
                      value: Math.max(0, presionBaja - 0.3),
                      umbralBaja: presionBaja,
                      umbralAlta: presionAlta,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: presión de red sostenidamente baja"
            >
              🌡️📉
            </button>
            <button
              className="vc-icon-only-btn"
              onClick={() => {
                setAlarmHistory((prev) =>
                  [
                    {
                      id: `alarm-presion-alta-${Date.now()}`,
                      ts: new Date().toISOString(),
                      lineId: null,
                      lineName: "Red / suministro general",
                      type: "presion_alta",
                      value: presionAlta + 0.5,
                      umbralBaja: presionBaja,
                      umbralAlta: presionAlta,
                    },
                    ...prev,
                  ].slice(0, MAX_ALARM_LOG)
                );
              }}
              title="🧪 Probar: presión de red sostenidamente alta"
            >
              🌡️📈
            </button>
          </div>
          )}
        </div>
        </div>
      )}



      {pantallaActiva === "lineas" && (
      <>
      <div className="vc-collector-wrap">
        <CollectorFlow
          lines={sectors.map((s) => ({
            name: s.name,
            active:
              (mainSupply && !maestraCerrada && isSectorActiveNow(s, now)) ||
              Number(s.sensors?.flowMeasured || 0) > 0,
          }))}
        />
      </div>

      </>
      )}

      {pantallaActiva === "plano" && (
        <div className="vc-pantalla-secundaria">
          <div className="vc-plano-header">
            <div>
              <div className="vc-history-title" style={{ marginBottom: 4 }}>Plano del proyecto</div>
              <p className="vc-tecnico-hint" style={{ margin: 0 }}>
                Sube el plano arquitectónico, un croquis o una foto de la instalación, y coloca cada línea sobre el punto exacto
                donde está físicamente. Se guarda junto con el resto de datos del panel.
              </p>
            </div>
            <div className="vc-plano-header-actions">
              {planoImagen && (
                <button
                  className={showPlanoImagen ? "vc-cliente-copiar-btn vc-summary-card-on" : "vc-cliente-copiar-btn"}
                  onClick={() => setShowPlanoImagen((v) => !v)}
                >
                  {showPlanoImagen ? "🗺️ ocultar plano" : "🗺️ ver plano"}
                </button>
              )}
              <label className="vc-cliente-copiar-btn" style={{ cursor: "pointer" }}>
                {planoImagen ? "cambiar imagen" : "📐 subir plano o foto"}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    subirPlano(e.target.files?.[0]);
                    setShowPlanoImagen(true);
                  }}
                />
              </label>
              {planoImagen && (
                <button className="vc-cliente-copiar-btn" onClick={() => setPlanoImagen(null)}>
                  quitar imagen
                </button>
              )}
              <button className="vc-plano-cerrar-btn" onClick={() => { setPantallaActiva("lineas"); setLineaColocando(null); }}>
                ✕ cerrar
              </button>
            </div>
          </div>

          {!planoImagen ? (
            <div className="vc-chart-empty">
              Todavía no has subido ningún plano — no hace falta para configurar las líneas, puedes hacerlo más abajo.
            </div>
          ) : !showPlanoImagen ? (
            <div className="vc-chart-empty">
              Plano guardado — pulsa "🗺️ ver plano" arriba para mostrarlo y colocar las líneas.
            </div>
          ) : (
            <>
              <div style={{ textAlign: "center" }}>
              <div
                className="vc-plano-imagen-wrap"
                onClick={(e) => {
                  if (!lineaColocando) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const xPct = Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10;
                  const yPct = Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10;
                  colocarLineaEnPlano(lineaColocando, xPct, yPct);
                }}
                style={{ cursor: lineaColocando ? "crosshair" : "default" }}
              >
                <img src={planoImagen} alt="Plano del proyecto" className="vc-plano-imagen" />
                {sectors
                  .filter((s) => s.posicionPlano)
                  .map((s) => {
                    const activa = isSectorActiveNow(s, now) || Number(s.sensors?.flowMeasured || 0) > 0;
                    const conAlarma = s.blockedByLeak || s.blockedByFault || s.minorLeakFlag || s.clogFlag;
                    const color = conAlarma ? "var(--vc-red)" : activa ? "var(--vc-flow)" : "var(--vc-brass)";
                    const humedad = s.sensors?.humidity;
                    return (
                      <div
                        key={s.id}
                        className={lineaResaltada === s.id ? "vc-plano-marcador vc-plano-marcador-on" : "vc-plano-marcador"}
                        style={{ left: s.posicionPlano.x + "%", top: s.posicionPlano.y + "%" }}
                        title={s.name + " · " + (activa ? "regando" : conAlarma ? "con alarma" : "en reposo") + " · " + humedad + "% humedad"}
                        onMouseEnter={() => setLineaResaltada(s.id)}
                        onMouseLeave={() => setLineaResaltada(null)}
                      >
                        <div className="vc-plano-marcador-barra" style={{ background: color }}>
                          {activa && <span className="vc-plano-marcador-flujo" />}
                          <span className="vc-plano-marcador-label">{s.name.replace("Línea ", "L")}</span>
                        </div>
                        <span className="vc-plano-marcador-humedad">{humedad}%</span>
                      </div>
                    );
                  })}
              </div>
              </div>

              {lineaColocando && (
                <p className="vc-tecnico-hint" style={{ color: "var(--vc-flow)" }}>
                  Pulsa sobre el plano en el punto donde está {sectors.find((s) => s.id === lineaColocando)?.name}…
                </p>
              )}
            </>
          )}

          {/* Superficie/exposición/difusores/caudal de cada línea: son datos
              importantes para el riego automático (cálculo de tandas), no
              dependen de tener una foto subida — por eso van siempre
              visibles aquí, aunque arriba no haya plano todavía. Solo la
              fila "sensor" (colocar el marcador sobre la imagen) necesita
              la foto de verdad, así que esa sí sigue condicionada a ella. */}
          <div className="vc-plano-lista">
            {sectors.map((s) => (
              <div key={s.id} className="vc-plano-lista-item vc-plano-lista-item-doble">
                <span>{s.name}</span>
                {planoImagen && showPlanoImagen && (
                  <div className="vc-plano-lista-fila">
                    <span className="vc-plano-lista-fila-label">sensor:</span>
                    {s.posicionPlano ? (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="vc-plano-btn-sm" onClick={() => setLineaColocando(s.id)}>
                          mover
                        </button>
                        <button className="vc-plano-btn-sm vc-plano-btn-sm-quitar" onClick={() => quitarLineaDePlano(s.id)}>
                          quitar
                        </button>
                      </div>
                    ) : (
                      <button
                        className={lineaColocando === s.id ? "vc-plano-btn-sm vc-plano-btn-sm-on" : "vc-plano-btn-sm"}
                        onClick={() => setLineaColocando(s.id)}
                      >
                        {lineaColocando === s.id ? "pulsa el plano…" : "colocar"}
                      </button>
                    )}
                  </div>
                )}
                <div className="vc-plano-lista-fila">
                  <span className="vc-plano-lista-fila-label">superficie:</span>
                  <input
                    type="number"
                    step="0.1"
                    value={s.areaM2 ?? 0}
                    onChange={(e) => updateSector(s.id, { ...s, areaM2: Number(e.target.value) })}
                    className="vc-plano-input-sm"
                  />
                  <span className="vc-plano-lista-fila-unidad">m²</span>
                </div>
                <div className="vc-plano-lista-fila">
                  <span className="vc-plano-lista-fila-label">exposición:</span>
                  <select
                    value={s.exposicion || "sol"}
                    onChange={(e) => updateSector(s.id, { ...s, exposicion: e.target.value })}
                    className="vc-plano-input-sm"
                  >
                    <option value="sol">☀ sol</option>
                    <option value="semisombra">⛅ semisombra</option>
                    <option value="sombra">☁ sombra</option>
                  </select>
                </div>
                <div className="vc-plano-lista-fila">
                  <span className="vc-plano-lista-fila-label">nº difusores:</span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={s.emitters ?? 0}
                    onChange={(e) => updateSector(s.id, { ...s, emitters: Number(e.target.value) })}
                    className="vc-plano-input-sm"
                  />
                </div>
                <div className="vc-plano-lista-fila">
                  <span className="vc-plano-lista-fila-label">caudal/difusor:</span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={s.emitterFlow ?? 0}
                    onChange={(e) => updateSector(s.id, { ...s, emitterFlow: Number(e.target.value) })}
                    className="vc-plano-input-sm"
                  />
                  <span className="vc-plano-lista-fila-unidad">L/h</span>
                </div>
                <div className="vc-plano-lista-fila">
                  <span className="vc-plano-lista-fila-label">caudal total línea:</span>
                  <span className="vc-plano-lista-fila-unidad">{Number(s.emitters || 0) * Number(s.emitterFlow || 0)} L/h</span>
                </div>
                {s.lineaBackendId && (
                  <div className="vc-plano-lista-fila">
                    <button
                      className="vc-plano-btn-sm"
                      disabled={guardandoConfigLinea === s.id}
                      onClick={() => guardarConfigLinea(s)}
                    >
                      {guardandoConfigLinea === s.id ? "guardando…" : "guardar en el servidor"}
                    </button>
                    {avisoGuardarConfigLinea && avisoGuardarConfigLinea.id === s.id && (
                      <span
                        style={{
                          fontSize: 11,
                          marginLeft: 8,
                          color: avisoGuardarConfigLinea.ok ? "var(--vc-open)" : "var(--vc-red)",
                        }}
                      >
                        {avisoGuardarConfigLinea.mensaje}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {pantallaActiva === "informe" && (
        <div className="vc-pantalla-secundaria vc-informe-print">
            <div className="vc-plano-header vc-informe-no-print">
              <div>
                <div className="vc-history-title" style={{ marginBottom: 4 }}>Informe de mantenimiento y firma</div>
                <p className="vc-tecnico-hint" style={{ margin: 0 }}>
                  Repasa los datos, firma con el dedo o el ratón en el recuadro, y guarda la firma. Luego usa "Imprimir /
                  guardar como PDF" para generar el informe y compartirlo con el cliente desde el propio menú de
                  compartir del móvil.
                </p>
              </div>
              <div className="vc-plano-header-actions">
                <button className="vc-cliente-copiar-btn" onClick={() => setPantallaActiva("ajustes")}>
                  ✕ cerrar
                </button>
              </div>
            </div>

            <div className="vc-informe-papel">
            <div className="vc-informe-encabezado">
              <div className="vc-informe-cabecera-marca">
                <span className="vc-informe-marca-fuerte">VERDTICAL</span>{" "}
                <span className="vc-informe-marca-suave">ECOSISTEMA S.L.</span>
              </div>
              <div className="vc-informe-etiqueta">INFORME DE MANTENIMIENTO</div>
              <div className="vc-informe-titulo-empresa">
                {proyecto.nombre || "Verdtical Ecosistema"}
              </div>
              <div className="vc-informe-fila">
                <span>
                  <strong>Técnico:</strong> {tecnico.nombre || "sin definir"}
                </span>
                <span>
                  <strong>Cliente:</strong> {cliente.nombre || "sin definir"}
                </span>
                <span>
                  <strong>Fecha:</strong> {now.toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" })}
                </span>
              </div>
            </div>

            {(() => {
              const ahora = new Date();
              const mesActual = ahora.getMonth();
              const anioActual = ahora.getFullYear();
              const nombreMes = ahora.toLocaleDateString("es-ES", { month: "long" });
              const lineasActivas = sectors.filter(
                (s) => isSectorActiveNow(s, now) || Number(s.sensors?.flowMeasured || 0) > 0
              ).length;
              const lineasBloqueadas = sectors.filter((s) => s.blockedByLeak || s.blockedByFault);
              const consumoPorLinea = sectors.map((s) => {
                const diasDelMes = (s.dailyConsumption || []).filter((d) => {
                  const fd = new Date(d.date);
                  return fd.getMonth() === mesActual && fd.getFullYear() === anioActual;
                });
                const totalDias = diasDelMes.reduce((sum, d) => sum + Number(d.liters || 0), 0);
                const total = Math.round((totalDias + Number(s.sensors?.litersToday || 0)) * 10) / 10;
                return { nombre: s.name, litros: total };
              });
              const totalConsumoMes = Math.round(consumoPorLinea.reduce((sum, l) => sum + l.litros, 0) * 10) / 10;
              const maxConsumoLinea = Math.max(1, ...consumoPorLinea.map((l) => l.litros));
              const fertilizanteMes = (fertilizerDailyHistory || []).filter((d) => {
                const fd = new Date(d.date);
                return fd.getMonth() === mesActual && fd.getFullYear() === anioActual;
              });
              const totalFertilizanteMes =
                Math.round(
                  (fertilizanteMes.reduce((sum, d) => sum + Number(d.consumoML || 0), 0) + Number(fertilizerConsumedToday || 0)) * 10
                ) / 10;
              return (
                <>
                  <div className="vc-informe-resumen">
                    <div className="vc-informe-resumen-stat">
                      <div className="vc-informe-resumen-valor">{sectors.length}</div>
                      <div className="vc-informe-resumen-label">líneas totales</div>
                    </div>
                    <div className="vc-informe-resumen-stat">
                      <div className="vc-informe-resumen-valor">{lineasActivas}</div>
                      <div className="vc-informe-resumen-label">regando ahora</div>
                    </div>
                    <div className="vc-informe-resumen-stat">
                      <div className="vc-informe-resumen-valor">{pressureBar} bar</div>
                      <div className="vc-informe-resumen-label">presión de red</div>
                    </div>
                    <div className="vc-informe-resumen-stat">
                      <div className="vc-informe-resumen-valor" style={{ color: fertilizerLevel < 15 ? "#c0392b" : undefined }}>
                        {fertilizerLevel}%
                      </div>
                      <div className="vc-informe-resumen-label">depósito fertilizante</div>
                    </div>
                  </div>
                  <div className="vc-informe-incidencias">
                    {lineasBloqueadas.length === 0
                      ? "✓ Sin incidencias abiertas en el momento del informe."
                      : `⚠ Líneas con incidencia abierta ahora mismo: ${lineasBloqueadas.map((s) => s.name).join(", ")}.`}
                  </div>

                  <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 6 }}>
                    Consumo de agua de {nombreMes} — {totalConsumoMes} L en total
                  </div>
                  <div className="vc-informe-consumo-tabla">
                    {consumoPorLinea.map((l) => (
                      <div className="vc-informe-consumo-fila" key={l.nombre}>
                        <span className="vc-informe-consumo-nombre">{l.nombre}</span>
                        <div className="vc-informe-consumo-barra-wrap">
                          <div
                            className="vc-informe-consumo-barra"
                            style={{ width: `${Math.max(4, (l.litros / maxConsumoLinea) * 100)}%` }}
                          />
                        </div>
                        <span className="vc-informe-consumo-valor">{l.litros} L</span>
                      </div>
                    ))}
                  </div>

                  <div className="vc-informe-fertilizante">
                    Fertilizante consumido en {nombreMes}: <strong>{totalFertilizanteMes} mL</strong>
                  </div>

                  {chartConsumoMensual.length > 1 && (
                    <>
                      <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 6 }}>
                        Evolución del consumo — últimos {chartConsumoMensual.length} meses
                      </div>
                      <div className="vc-informe-mensual-grafica">
                        {(() => {
                          const maxMensual = Math.max(1, ...chartConsumoMensual.map((m) => m.liters));
                          return chartConsumoMensual.map((m, i) => (
                            <div className="vc-informe-mensual-barra-col" key={i}>
                              <div className="vc-informe-mensual-barra-wrap">
                                <div
                                  className="vc-informe-mensual-barra"
                                  style={{ height: `${Math.max(4, (m.liters / maxMensual) * 100)}%` }}
                                />
                              </div>
                              <span className="vc-informe-mensual-valor">{m.liters}</span>
                              <span className="vc-informe-mensual-label">{m.label}</span>
                            </div>
                          ));
                        })()}
                      </div>
                      <p className="vc-tecnico-hint" style={{ marginTop: 6, marginBottom: 0 }}>
                        Suma de todas las líneas juntas, agrupada por mes (litros).
                      </p>
                    </>
                  )}
                </>
              );
            })()}

            <div className="vc-history-title vc-informe-no-print" style={{ marginTop: 14, marginBottom: 4 }}>Procesos realizados en esta visita</div>
            <div className="vc-tecnico-checks vc-informe-no-print">
              {CATALOGO_PROCESOS_MANTENIMIENTO.map((p) => (
                <label className="vc-tecnico-check" key={p.key}>
                  <input
                    type="checkbox"
                    checked={procesosRealizados[p.key] === true}
                    onChange={(e) => setProcesosRealizados({ ...procesosRealizados, [p.key]: e.target.checked })}
                  />
                  {p.label}
                </label>
              ))}
            </div>
            <div className="vc-informe-procesos vc-informe-solo-print">
              {CATALOGO_PROCESOS_MANTENIMIENTO.filter((p) => procesosRealizados[p.key]).length === 0 ? (
                <div className="vc-history-empty">No se han registrado trabajos específicos en esta visita.</div>
              ) : (
                CATALOGO_PROCESOS_MANTENIMIENTO.filter((p) => procesosRealizados[p.key]).map((p) => (
                  <div key={p.key} style={{ marginBottom: 8 }}>
                    <div>✓ {p.label}</div>
                    <div style={{ fontSize: 10, color: "var(--vc-text-muted)", marginTop: 2 }}>{p.detalle}</div>
                  </div>
                ))
              )}
            </div>
            {cliente.proximoMantenimiento && (
              <>
                <div className="vc-history-title vc-informe-solo-print" style={{ marginTop: 14, marginBottom: 4 }}>
                  Próxima visita de mantenimiento
                </div>
                <p className="vc-tecnico-hint vc-informe-solo-print" style={{ marginTop: 0 }}>
                  {new Date(cliente.proximoMantenimiento).toLocaleDateString("es-ES", {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                    year: "numeric",
                  })}
                </p>
              </>
            )}

            <label className="vc-tecnico-field vc-informe-no-print" style={{ marginTop: 8 }}>
              Nota de observación
              <textarea
                rows={2}
                value={notaObservacion}
                onChange={(e) => setNotaObservacion(e.target.value)}
                placeholder="Comentarios, incidencias vistas in situ, recomendaciones…"
              />
            </label>
            {notaObservacion && (
              <>
                <div className="vc-history-title vc-informe-solo-print" style={{ marginTop: 14, marginBottom: 4 }}>Observaciones</div>
                <p className="vc-tecnico-hint vc-informe-solo-print" style={{ marginTop: 0 }}>{notaObservacion}</p>
              </>
            )}
            <div className="vc-informe-no-print vc-firma-botones" style={{ marginTop: 0 }}>
              {cliente.email ? (
                <a
                  className="vc-cliente-informe-btn"
                  href={enviarInformeMantenimientoCliente()}
                  style={{ textDecoration: "none", display: "inline-block", textAlign: "center" }}
                >
                  ✉ enviar por email
                </a>
              ) : (
                <button className="vc-cliente-informe-btn" disabled>
                  ✉ enviar por email
                </button>
              )}
              {cliente.telefono ? (
                <a
                  className="vc-cliente-informe-btn vc-informe-whatsapp-btn"
                  href={enviarInformeMantenimientoWhatsapp()}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: "none", display: "inline-block", textAlign: "center" }}
                >
                  📱 enviar por WhatsApp
                </a>
              ) : (
                <button className="vc-cliente-informe-btn" disabled>
                  📱 enviar por WhatsApp
                </button>
              )}
            </div>
            {(!cliente.email || !cliente.telefono) && (
              <p className="vc-tecnico-hint vc-informe-no-print" style={{ margin: 0 }}>
                {!cliente.email && "añade un email al cliente"}
                {!cliente.email && !cliente.telefono && " y "}
                {!cliente.telefono && "añade un teléfono al cliente"} (en el botón Cliente) para poder enviarlo por esa vía
              </p>
            )}

            <div className="vc-informe-firmas-doble">
              <div>
                <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Firma del técnico</div>
                <div className="vc-firma-wrap">
                  <canvas
                    ref={firmaCanvasRef}
                    width={500}
                    height={130}
                    className="vc-firma-canvas"
                    onMouseDown={firmaTecnico.empezarTrazo}
                    onMouseMove={firmaTecnico.continuarTrazo}
                    onMouseUp={firmaTecnico.terminarTrazo}
                    onMouseLeave={firmaTecnico.terminarTrazo}
                    onTouchStart={firmaTecnico.empezarTrazo}
                    onTouchMove={firmaTecnico.continuarTrazo}
                    onTouchEnd={firmaTecnico.terminarTrazo}
                  />
                </div>
                <div className="vc-informe-no-print vc-firma-botones">
                  <button className="vc-toggle-btn" onClick={firmaTecnico.borrar}>
                    🗑 borrar
                  </button>
                  <button className="vc-toggle-btn vc-firma-guardar-btn" onClick={firmaTecnico.guardar}>
                    ✓ guardar
                  </button>
                </div>
                {firmaFecha && (
                  <p className="vc-tecnico-hint" style={{ marginTop: 8 }}>
                    Firmado el {new Date(firmaFecha).toLocaleString("es-ES")}
                  </p>
                )}
              </div>
              <div>
                <div className="vc-history-title" style={{ marginTop: 14, marginBottom: 4 }}>Conformidad del cliente</div>
                <div className="vc-firma-wrap">
                  <canvas
                    ref={firmaClienteCanvasRef}
                    width={500}
                    height={130}
                    className="vc-firma-canvas"
                    onMouseDown={firmaCliente.empezarTrazo}
                    onMouseMove={firmaCliente.continuarTrazo}
                    onMouseUp={firmaCliente.terminarTrazo}
                    onMouseLeave={firmaCliente.terminarTrazo}
                    onTouchStart={firmaCliente.empezarTrazo}
                    onTouchMove={firmaCliente.continuarTrazo}
                    onTouchEnd={firmaCliente.terminarTrazo}
                  />
                </div>
                <div className="vc-informe-no-print vc-firma-botones">
                  <button className="vc-toggle-btn" onClick={firmaCliente.borrar}>
                    🗑 borrar
                  </button>
                  <button className="vc-toggle-btn vc-firma-guardar-btn" onClick={firmaCliente.guardar}>
                    ✓ guardar
                  </button>
                </div>
                {firmaClienteFecha && (
                  <p className="vc-tecnico-hint" style={{ marginTop: 8 }}>
                    Conforme el {new Date(firmaClienteFecha).toLocaleString("es-ES")}
                  </p>
                )}
              </div>
            </div>
            <p className="vc-tecnico-hint vc-informe-no-print" style={{ marginTop: 4 }}>
              Si el cliente está presente, puede firmar directamente aquí, en el mismo dispositivo, para dejar constancia
              de su conformidad con los trabajos realizados.
            </p>
            <div className="vc-informe-no-print vc-firma-botones">
              <button className="vc-toggle-btn vc-firma-guardar-btn" onClick={() => window.print()}>
                🖨️ imprimir / guardar como PDF
              </button>
            </div>
            </div>
        </div>
      )}

      {pantallaActiva === "listado" && (
        <div className="vc-pantalla-secundaria">
            <div className="vc-plano-header">
              <div>
                <div className="vc-history-title" style={{ marginBottom: 4 }}>Listado de horarios — todas las líneas</div>
                <p className="vc-tecnico-hint" style={{ margin: 0 }}>
                  Todos los riegos programados de las {sectors.length} líneas, ordenados por hora. En rojo, los que se cruzan con
                  otra línea (mismo día, misma franja). Debajo, los huecos del día en los que ninguna línea está regando.
                </p>
              </div>
              <button className="vc-plano-cerrar-btn" onClick={() => setPantallaActiva("programacion")}>
                ✕ cerrar
              </button>
            </div>

            <div className="vc-season-tabs">
              {ESTACIONES.map((est) => (
                <button
                  key={est.key}
                  className={temporadaListado === est.key ? "vc-season-tab vc-season-tab-on" : "vc-season-tab"}
                  onClick={() => setTemporadaListado(est.key)}
                >
                  {est.label}
                </button>
              ))}
            </div>

            {(() => {
              const listado = construirListadoHorarios(sectors, temporadaListado);
              const huecos = calcularHuecosLibres(listado);
              const conflictosCount = listado.filter((ev) => ev.conflictoCon).length;

              // Resumen de actuaciones por línea: cuántas tandas, minutos y
              // litros totales riega cada una en esta estación.
              const resumenPorLinea = sectors.map((s) => {
                const eventosLinea = listado.filter((ev) => ev.lineId === s.id);
                const minutosTotales = eventosLinea.reduce((sum, ev) => sum + ev.duration, 0);
                const nominalFlowLinea = Number(s.emitters || 0) * Number(s.emitterFlow || 0);
                const litrosTotales = Math.round(((minutosTotales / 60) * nominalFlowLinea) * 10) / 10;
                return { nombre: s.name, actuaciones: eventosLinea.length, minutosTotales, litrosTotales };
              });

              return (
                <>
                  <div className="vc-history-title" style={{ margin: "0 0 8px" }}>Total de actuaciones por línea</div>
                  <div className="vc-resumen-lineas-tabla">
                    <div className="vc-resumen-lineas-cabecera">
                      <span>Línea</span>
                      <span>Actuaciones/día</span>
                      <span>Minutos/día</span>
                      <span>Litros/día</span>
                    </div>
                    {resumenPorLinea.map((r) => (
                      <div key={r.nombre} className="vc-resumen-lineas-fila">
                        <span>{r.nombre}</span>
                        <span>{r.actuaciones}</span>
                        <span>{r.minutosTotales} min</span>
                        <span>{r.litrosTotales} L</span>
                      </div>
                    ))}
                  </div>

                  <div className="vc-listado-resumen" style={{ marginTop: 16 }}>
                    {listado.length} riego(s) programado(s) en total
                    {conflictosCount > 0 ? ` · ⚠ ${conflictosCount} se cruzan con otra línea` : " · ✅ ninguno se cruza"}
                  </div>

                  {listado.length === 0 ? (
                    <div className="vc-chart-empty">Todavía no hay ningún horario programado en esta temporada.</div>
                  ) : (
                    <div className="vc-listado-tabla">
                      {listado.map((ev, idx) => (
                        <div
                          key={idx}
                          className={ev.conflictoCon ? "vc-listado-fila vc-listado-fila-conflicto" : "vc-listado-fila"}
                        >
                          <span className="vc-listado-hora">
                            {ev.time} – {formatoHora(ev.fin)}
                          </span>
                          <span className="vc-listado-linea">{ev.lineName}</span>
                          <span className="vc-listado-duracion">{ev.duration} min</span>
                          <span className="vc-listado-dias">{ev.days.join(" ")}</span>
                          {ev.conflictoCon && <span className="vc-listado-conflicto-txt">⚠ se cruza con {ev.conflictoCon}</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="vc-history-title" style={{ margin: "16px 0 8px" }}>Huecos libres del día (sin ninguna línea regando)</div>
                  {huecos.length === 0 ? (
                    <div className="vc-chart-empty">No queda ningún hueco libre — el día está completo de riegos.</div>
                  ) : (
                    <div className="vc-huecos-lista">
                      {huecos.map((h, idx) => (
                        <span key={idx} className="vc-hueco-chip">
                          {formatoHora(h.inicio)} – {formatoHora(h.fin)} ({h.fin - h.inicio} min libres)
                        </span>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
        </div>
      )}

      <div className="vc-grid">
        {pantallaActiva === "lineas" && sectors.map((s) => {
          const etoLinea = { sol: etoSol, semisombra: etoSemisombra, sombra: etoSombra }[s.exposicion] ?? etoSol;
          const necesidadTeorica = Math.round(Number(s.areaM2 || 0) * etoLinea * 10) / 10;
          const consumoAyerLinea = consumoDeAyer(s, now);
          const consumoRealLinea = consumoAyerLinea ?? 0;
          const diferenciaLinea = Math.round((consumoRealLinea - necesidadTeorica) * 10) / 10;
          const diferenciaPct = necesidadTeorica > 0 ? Math.round((diferenciaLinea / necesidadTeorica) * 100) : 0;
          const balanceHidrico = {
            necesidadTeorica,
            consumoRealLinea,
            diferenciaLinea,
            diferenciaPct,
            hayDatos: consumoAyerLinea !== null,
          };
          return (
            <SectorCard
              key={s.id}
              sector={s}
              now={now}
              mainSupply={mainSupply}
              maestraCerrada={maestraCerrada}
              tecnico={tecnico}
              cliente={cliente}
              presionEnRangoTrabajo={presionEnRangoTrabajo}
              presionBaja={presionBaja}
              presionAlta={presionAlta}
              balanceHidrico={balanceHidrico}
              umbralBalanceHidrico={umbralBalanceHidrico}
              todosLosSectores={sectors}
              etoSol={etoSol}
              etoSemisombra={etoSemisombra}
              etoSombra={etoSombra}
              factoresEstacionales={factoresEstacionales}
              alarmHistory={alarmHistory}
              alarmasInstalacion={alarmasInstalacion}
              onUpdate={(updated) => updateSector(s.id, updated)}
              onRemove={() => removeSector(s.id)}
              onRearm={rearmarLinea}
              onRearmFault={rearmarLineaFault}
              guardandoConfig={guardandoConfigLinea === s.id}
              avisoGuardarConfig={avisoGuardarConfigLinea && avisoGuardarConfigLinea.id === s.id ? avisoGuardarConfigLinea : null}
              onGuardarConfig={() => guardarConfigLinea(s)}
            />
          );
        })}
      </div>
      {pantallaActiva === "lineas" && (
        <button className="vc-add-card" onClick={addSector}>
          + añadir línea
        </button>
      )}

      <div className="vc-tabbar-spacer" />
      <nav className="vc-tabbar">
        <button
          className={pantallaActiva === "lineas" ? "vc-tabbar-btn vc-tabbar-btn-on" : "vc-tabbar-btn"}
          onClick={() => setPantallaActiva("lineas")}
        >
          <span className="vc-tabbar-icon">💧</span>
          <span>Líneas</span>
        </button>
        <button
          className={pantallaActiva === "plano" ? "vc-tabbar-btn vc-tabbar-btn-on" : "vc-tabbar-btn"}
          onClick={() => setPantallaActiva("plano")}
        >
          <span className="vc-tabbar-icon">🗺️</span>
          <span>Plano</span>
        </button>
        <button
          className={pantallaActiva === "programacion" ? "vc-tabbar-btn vc-tabbar-btn-on" : "vc-tabbar-btn"}
          onClick={() => setPantallaActiva("programacion")}
        >
          <span className="vc-tabbar-icon">📅</span>
          <span>Programación</span>
        </button>
        <button
          className={pantallaActiva === "ajustes" ? "vc-tabbar-btn vc-tabbar-btn-on" : "vc-tabbar-btn"}
          onClick={() => setPantallaActiva("ajustes")}
        >
          <span className="vc-tabbar-icon">⚙️</span>
          <span>Ajustes</span>
        </button>
      </nav>
    </div>
  );
}
