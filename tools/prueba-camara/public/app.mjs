/**
 * PROBADOR DE CÁMARA Y CÓDIGOS DE BARRAS — lógica de la página.
 *
 * Objetivo: responder UNA pregunta, con evidencia, en el celular:
 *   ¿este teléfono puede leer un código de barras sobre HTTPS con certificado válido?
 *
 * Diseño de la página, y por qué:
 *   1. Diagnóstico         → cuando falla, dice QUÉ falló, no solo que falló.
 *   2. QR                  → pasar la dirección al celular sin teclearla.
 *   3. Cámara y lectura    → la prueba real, con BarcodeDetector o ZXing.
 *   4. Códigos de prueba   → se dibujan y SE LEEN SOLOS. Prueba el decodificador
 *                            aunque la cámara no funcione, separando las dos fallas.
 *
 * Los dos decodificadores:
 *   · BarcodeDetector  → nativo, rápido, sin descargas. Android (Chrome/Edge).
 *   · ZXing-WASM       → respaldo universal (incluye iPhone, que no lo trae).
 */

import { CODIGOS_DE_PRUEBA, autoprueba } from './codigos.mjs';

const ENTORNO = window.__ENTORNO__ ?? {};
const $ = (sel) => document.querySelector(sel);

function crear(etiqueta, props = {}, hijos = []) {
  const nodo = document.createElement(etiqueta);
  if (props.clase) nodo.className = props.clase;
  if (props.texto !== undefined) nodo.textContent = props.texto;
  if (props.atributos) for (const [k, v] of Object.entries(props.atributos)) nodo.setAttribute(k, v);
  if (props.eventos) for (const [k, v] of Object.entries(props.eventos)) nodo.addEventListener(k, v);
  for (const hijo of [].concat(hijos)) if (hijo) nodo.append(hijo);
  return nodo;
}

const hayBarcodeDetector = () => typeof window.BarcodeDetector !== 'undefined';
const hayZXing = () => typeof window.ZXingWASM !== 'undefined';
const hayBwip = () => typeof window.bwipjs !== 'undefined';

// ─────────────────────────────────────────────────────────────
// FORMATOS
// El id es el nombre que entiende BarcodeDetector (snake_case) y `zxing` el que
// entiende ZXing-WASM (nombre canónico). No son intercambiables: cada API tiene
// su propio vocabulario y confundirlos es un fallo silencioso.
// ─────────────────────────────────────────────────────────────

const FORMATOS = [
  { id: 'ean_13', zxing: 'EAN-13', etiqueta: 'EAN-13 / UPC', activo: true, nota: 'Productos con código de fábrica y tus códigos internos (prefijo 2)' },
  { id: 'code_128', zxing: 'Code 128', etiqueta: 'Code 128', activo: true, nota: 'Etiquetas de anaquel, paquetes y cajas' },
  { id: 'qr_code', zxing: 'QRCode', etiqueta: 'QR', activo: true, nota: 'Listas escolares y datos densos' },
  { id: 'ean_8', zxing: 'EAN-8', etiqueta: 'EAN-8', activo: false, nota: 'Envases chicos' },
  { id: 'upc_a', zxing: 'UPC-A', etiqueta: 'UPC-A', activo: false, nota: 'Importados de Estados Unidos' },
  { id: 'code_39', zxing: 'Code 39', etiqueta: 'Code 39', activo: false, nota: 'Algunos proveedores de papelería' },
  { id: 'itf', zxing: 'ITF', etiqueta: 'ITF', activo: false, nota: 'Cajas de cartón de mayoreo' },
];

const estado = {
  activo: false,
  lector: null,
  tipoLector: null,
  flujo: null,
  ocupado: false,
  ultimoIntento: 0,
  ultima: { texto: null, t: 0, veces: 0 },
  lienzo: null,
};

// ─────────────────────────────────────────────────────────────
// 1. INSIGNIAS Y AVISOS
// ─────────────────────────────────────────────────────────────

function pintaInsignias() {
  const caja = $('#insignias');
  const segura = window.isSecureContext;
  caja.append(
    crear('span', { clase: `insignia ${segura ? 'buena' : 'mala'}`, texto: segura ? 'contexto seguro ✅' : 'contexto NO seguro ⛔' }),
    crear('span', { clase: 'insignia', texto: location.host || 'origen local' }),
    crear('span', { clase: 'insignia', texto: hayBarcodeDetector() ? 'BarcodeDetector nativo' : 'sin BarcodeDetector' }),
    crear('span', { clase: 'insignia', texto: hayZXing() ? 'ZXing-WASM cargado' : 'ZXing-WASM no cargado' }),
  );
}

function pintaAvisos() {
  const caja = $('#avisos');
  const avisos = [];

  if (!window.isSecureContext) {
    avisos.push(crear('div', { clase: 'aviso malo' }, [
      crear('strong', { texto: '⛔ Este navegador no considera la página segura, así que la cámara está bloqueada.' }),
      crear('p', {
        texto:
          'La cámara solo funciona en un contexto seguro. Revisa que la dirección empiece con https:// y que el certificado esté instalado Y confiado en el celular. ' +
          'Instalar la página como aplicación NO evita esto: es el error más común.',
      }),
    ]));
  }

  if (location.protocol === 'http:' && location.port === '8443') {
    avisos.push(crear('div', { clase: 'aviso ojo' }, [
      crear('strong', { texto: '⚠️ Entraste por http en el puerto de la cámara.' }),
      crear('p', { texto: 'Cambia http:// por https://. Sin cifrado el navegador no da acceso a la cámara.' }),
    ]));
  }

  if (!hayBarcodeDetector() && !hayZXing()) {
    avisos.push(crear('div', { clase: 'aviso ojo' }, [
      crear('strong', { texto: '⚠️ Ningún lector disponible.' }),
      crear('p', {
        texto:
          'Este navegador no trae BarcodeDetector y no se pudo cargar ZXing desde internet. Conéctate a internet una vez, o usa Chrome en Android.',
      }),
    ]));
  }

  if (ENTORNO.certificado?.error) {
    avisos.push(crear('div', { clase: 'aviso ojo' }, [
      crear('strong', { texto: '⚠️ No se pudo leer el certificado en el servidor.' }),
      crear('p', { texto: ENTORNO.certificado.error }),
    ]));
  } else if (ENTORNO.certificado && ENTORNO.certificado.cubreIp === false) {
    avisos.push(crear('div', { clase: 'aviso malo' }, [
      crear('strong', { texto: `⛔ El certificado no incluye la dirección ${ENTORNO.ipLan}.` }),
      crear('p', {
        texto:
          'Por eso el celular muestra una advertencia de seguridad. Vuelve a generar el certificado con la IP actual: ' +
          'pnpm certificado  (la IP cambia cuando reinicias el módem).',
      }),
    ]));
  }

  if (!hayBwip()) {
    avisos.push(crear('div', { clase: 'aviso ojo' }, [
      crear('strong', { texto: '⚠️ No se cargó el generador de códigos (bwip-js) desde internet.' }),
      crear('p', { texto: 'La sección 4 no podrá dibujar los códigos de prueba. La cámara sí se puede probar apuntando a un producto real.' }),
    ]));
  }

  for (const aviso of avisos) caja.append(aviso);
}

// ─────────────────────────────────────────────────────────────
// 2. DIAGNÓSTICO
// ─────────────────────────────────────────────────────────────

function fila(nombre, valor, nivel = 'ojo') {
  const punto = crear('span', { clase: `punto ${nivel}` });
  return crear('tr', {}, [
    crear('th', { texto: nombre }),
    crear('td', {}, [punto, document.createTextNode(String(valor))]),
  ]);
}

async function pintaDiagnostico() {
  const tbody = $('#diag');
  tbody.replaceChildren();

  const agregar = (n, v, nivel) => tbody.append(fila(n, v, nivel));

  agregar('Contexto seguro', window.isSecureContext ? 'sí' : 'NO — la cámara estará bloqueada', window.isSecureContext ? 'ok' : 'mal');
  agregar('Origen', location.origin, 'ojo');
  agregar('API de cámara', navigator.mediaDevices?.getUserMedia ? 'disponible' : 'NO disponible', navigator.mediaDevices?.getUserMedia ? 'ok' : 'mal');

  if (hayBarcodeDetector()) {
    try {
      const soportados = await window.BarcodeDetector.getSupportedFormats();
      agregar('Lector nativo', `BarcodeDetector (${soportados.length} formatos)`, 'ok');
      agregar('Formatos nativos', soportados.join(', '), 'ok');
    } catch (e) {
      agregar('Lector nativo', `presente, pero getSupportedFormats falló: ${e.message}`, 'ojo');
    }
  } else {
    agregar('Lector nativo', 'no existe en este navegador (iPhone: es normal)', 'ojo');
  }

  agregar('Lector de respaldo', hayZXing() ? 'ZXing-WASM cargado' : 'no cargado (revisa internet)', hayZXing() ? 'ok' : 'mal');
  agregar('Generador de códigos', hayBwip() ? 'bwip-js cargado' : 'no cargado', hayBwip() ? 'ok' : 'ojo');

  if (navigator.permissions?.query) {
    try {
      const permiso = await navigator.permissions.query({ name: 'camera' });
      agregar('Permiso de cámara', permiso.state === 'granted' ? 'concedido' : permiso.state === 'denied' ? 'DENEGADO' : 'aún no se ha pedido', permiso.state === 'denied' ? 'mal' : permiso.state === 'granted' ? 'ok' : 'ojo');
    } catch {
      agregar('Permiso de cámara', 'este navegador no lo reporta', 'ojo');
    }
  }

  try {
    const dispositivos = (await navigator.mediaDevices?.enumerateDevices?.() ?? []).filter((d) => d.kind === 'videoinput');
    agregar('Cámaras', dispositivos.length ? `${dispositivos.length}: ` + dispositivos.map((d, i) => d.label || `cámara ${i + 1}`).join(' · ') : 'ninguna visible todavía (se piden al encender)', dispositivos.length ? 'ok' : 'ojo');
  } catch {
    agregar('Cámaras', 'no se pudieron listar', 'ojo');
  }

  const cert = ENTORNO.certificado;
  if (cert && !cert.error) {
    agregar('Certificado (sujeto)', cert.sujeto ?? '—', 'ojo');
    agregar('Certificado (vence)', cert.vence ?? '—', new Date(cert.vence) < new Date() ? 'mal' : 'ok');
    agregar('Certificado cubre la IP', cert.cubreIp === true ? `sí, ${ENTORNO.ipLan}` : `NO incluye ${ENTORNO.ipLan}`, cert.cubreIp === true ? 'ok' : 'mal');
    agregar('Nombres del certificado', cert.sans ?? '—', 'ojo');
  }

  agregar('Este equipo', navigator.userAgent, 'ojo');

  // Autoprueba de la copia local de códigos de barras
  for (const caso of autoprueba()) {
    agregar(
      `Códigos: ${caso.nombre}`,
      caso.ok ? `${caso.obtenido} ✓` : `esperaba ${caso.esperado}, dio ${caso.obtenido}`,
      caso.ok ? 'ok' : 'mal',
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 3. QR Y DIRECCIONES
// ─────────────────────────────────────────────────────────────

function pintaQr() {
  const destino = ENTORNO.urlCertificado || location.origin;
  const texto = [
    `Certificado (http):  ${ENTORNO.urlCertificado ?? location.origin}`,
    `Cámara (https):      ${ENTORNO.urlCamara ?? location.origin}`,
  ].join('\n');
  $('#enlace-celular').textContent = texto;

  if (!hayBwip()) {
    $('#qr').replaceWith(crear('p', { clase: 'ayuda', texto: 'Sin internet no se puede dibujar el QR. Escribe la dirección a mano.' }));
    return;
  }

  try {
    // El QR apunta al servidor http a propósito: ese siempre abre, incluso sin
    // certificado instalado. Desde ahí se instala el certificado y se pasa a https.
    window.bwipjs.toCanvas($('#qr'), { bcid: 'qrcode', text: destino, scale: 3, paddingwidth: 8, paddingheight: 8 });
  } catch (e) {
    $('#qr').replaceWith(crear('p', { clase: 'ayuda', texto: `No se pudo dibujar el QR: ${e.message}` }));
  }
}

// ─────────────────────────────────────────────────────────────
// 4. LECTORES
// ─────────────────────────────────────────────────────────────

function formatosElegidos() {
  const marcados = new Set(
    [...document.querySelectorAll('#formatos input[type=checkbox]')].filter((c) => c.checked).map((c) => c.dataset.formato),
  );
  const lista = FORMATOS.filter((f) => marcados.has(f.id));
  return lista.length ? lista : FORMATOS.filter((f) => f.activo);
}

function pintaFormatos() {
  const caja = $('#formatos');
  caja.replaceChildren();

  const soportadosNativos = estado.formatosNativos ?? null;

  for (const formato of FORMATOS) {
    const compatible = !soportadosNativos || soportadosNativos.includes(formato.id);
    const casilla = crear('input', {
      atributos: { type: 'checkbox', ...(formato.activo ? { checked: 'checked' } : {}) },
    });
    casilla.checked = formato.activo && compatible;
    casilla.dataset.formato = formato.id;
    casilla.disabled = !compatible;

    caja.append(crear('label', { atributos: { title: compatible ? '' : 'Este navegador no lo soporta de forma nativa' } }, [
      casilla,
      crear('span', {}, [
        crear('span', { texto: formato.etiqueta + (compatible ? '' : ' (no soportado)') }),
        crear('small', { texto: formato.nota }),
      ]),
    ]));
  }
}

/** Crea un lector utilizable sin cámara (sirve para la autoprueba de la sección 4). */
async function crearLector() {
  const preferencia = $('#sel-lector').value;
  const nativoOk = hayBarcodeDetector();
  const zxingOk = hayZXing();

  const tipo =
    preferencia === 'nativo' ? (nativoOk ? 'nativo' : null)
    : preferencia === 'zxing' ? (zxingOk ? 'zxing' : null)
    : nativoOk ? 'nativo'
    : zxingOk ? 'zxing'
    : null;

  if (!tipo) {
    throw new Error('No hay ningún lector disponible. Este navegador no trae BarcodeDetector y no se cargó ZXing desde internet.');
  }

  const formatos = formatosElegidos();

  if (tipo === 'nativo') {
    const soportados = await window.BarcodeDetector.getSupportedFormats();
    const validos = formatos.filter((f) => soportados.includes(f.id));
    if (!validos.length) throw new Error('El lector nativo no soporta ninguno de los formatos marcados.');
    const detector = new window.BarcodeDetector({ formats: validos.map((f) => f.id) });
    return {
      tipo: 'nativo',
      detalle: `BarcodeDetector nativo · ${validos.map((f) => f.id).join(', ')}`,
      async detectar(fuente) {
        const resultados = await detector.detect(fuente);
        return resultados.map((r) => ({ texto: r.rawValue, formato: r.format }));
      },
    };
  }

  // Despertar el módulo WebAssembly (baja ~1 MB la primera vez).
  try {
    await window.ZXingWASM.prepareZXingModule?.({ fireImmediately: true });
  } catch (e) {
    console.warn('No se pudo precalentar ZXing:', e);
  }

  return {
    tipo: 'zxing',
    detalle: `ZXing-WASM · ${formatos.map((f) => f.zxing).join(', ')}`,
    async detectar(fuente) {
      const imagen = imagenDe(fuente);
      const resultados = await window.ZXingWASM.readBarcodes(imagen, {
        tryHarder: $('#chk-tryharder').checked,
        formats: formatos.map((f) => f.zxing),
        maxNumberOfSymbols: 1,
      });
      return resultados.filter((r) => r.text).map((r) => ({ texto: r.text, formato: r.format }));
    },
  };
}

function dimensionesDe(fuente) {
  if (fuente instanceof HTMLVideoElement) return [fuente.videoWidth, fuente.videoHeight];
  return [fuente.width, fuente.height];
}

/** Recorta una región (en fracciones 0..1) a un lienzo propio, para leer solo esa parte. */
function recortar(fuente, region) {
  const [ancho, alto] = dimensionesDe(fuente);
  const x = Math.round(ancho * region.x);
  const y = Math.round(alto * region.y);
  const w = Math.max(1, Math.round(ancho * region.w));
  const h = Math.max(1, Math.round(alto * region.h));

  estado.lienzo ??= document.createElement('canvas');
  const lienzo = estado.lienzo;
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(fuente, x, y, w, h, 0, 0, w, h);
  return lienzo;
}

const REGION_TOTAL = { x: 0, y: 0, w: 1, h: 1 };
/** Banda central: los códigos 1D se leen mejor sin el ruido de arriba y abajo. */
const REGION_BANDA = { x: 0, y: 0.3, w: 1, h: 0.4 };

function imagenDe(fuente) {
  const lienzo = fuente instanceof HTMLCanvasElement ? fuente : recortar(fuente, REGION_TOTAL);
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, lienzo.width, lienzo.height);
}

// ─────────────────────────────────────────────────────────────
// 5. CÁMARA
// ─────────────────────────────────────────────────────────────

function mostrarErrorCamara(error) {
  const nombre = error?.name ?? '';
  let explicacion = error?.message ?? String(error);

  if (nombre === 'NotAllowedError') {
    explicacion = 'Se negó el permiso. Ábrelo en los ajustes del navegador para este sitio y vuelve a intentar. En iPhone: Ajustes → Safari → Cámara.';
  } else if (nombre === 'NotFoundError' || nombre === 'OverconstrainedError') {
    explicacion = 'No se encontró ninguna cámara disponible. Cierra otras apps que la estén usando.';
  } else if (nombre === 'NotReadableError') {
    explicacion = 'La cámara existe pero el sistema no la suelta. Reinicia el navegador del celular.';
  } else if (!window.isSecureContext) {
    explicacion = 'Sin contexto seguro el navegador ni siquiera pregunta: la cámara está bloqueada por no ser https con certificado válido.';
  }

  $('#marca-agua').classList.remove('oculto');
  $('#marca-agua').textContent = 'No se pudo encender la cámara';
  $('#ultimaLectura').className = 'vacia';
  $('#ultimaLectura').textContent = `${nombre || 'Error'}: ${explicacion}`;
}

async function encenderCamara() {
  const video = $('#video');
  $('#btn-encender').disabled = true;

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no expone la cámara. ¿Estás en http:// en lugar de https://?');
    }

    estado.lector = await crearLector();
    estado.tipoLector = estado.lector.tipo;

    const flujo = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    estado.flujo = flujo;
    video.srcObject = flujo;
    video.setAttribute('playsinline', '');
    await video.play();

    estado.activo = true;
    $('#marca-agua').classList.add('oculto');
    $('#guia').classList.remove('oculto');
    $('#btn-encender').classList.add('oculto');
    $('#btn-apagar').classList.remove('oculto');
    $('#ultimaLectura').className = 'vacia';
    $('#ultimaLectura').textContent = `Buscando… (${estado.lector.detalle})`;

    const pista = flujo.getVideoTracks()[0]?.getSettings?.() ?? {};
    $('#video').dataset.pista =
      `${pista.width ?? '?'}×${pista.height ?? '?'} @ ${Math.round(pista.frameRate ?? 0)} fps`;

    programarFotograma();
  } catch (error) {
    mostrarErrorCamara(error);
    $('#btn-encender').disabled = false;
  }
}

function apagarCamara() {
  estado.activo = false;
  for (const pista of estado.flujo?.getTracks?.() ?? []) pista.stop();
  estado.flujo = null;
  $('#video').srcObject = null;
  $('#btn-encender').classList.remove('oculto');
  $('#btn-encender').disabled = false;
  $('#btn-apagar').classList.add('oculto');
  $('#guia').classList.add('oculto');
  $('#marca-agua').classList.remove('oculto');
  $('#marca-agua').textContent = 'La cámara está apagada';
}

function programarFotograma() {
  const video = $('#video');
  if (!estado.activo) return;

  const paso = async () => {
    if (!estado.activo) return;

    const ahora = performance.now();
    if (!estado.ocupado && ahora - estado.ultimoIntento > 200) {
      estado.ocupado = true;
      estado.ultimoIntento = ahora;
      try {
        await intentarLectura(video);
      } catch (error) {
        console.warn('Fallo al leer un fotograma:', error);
      } finally {
        estado.ocupado = false;
      }
    }

    if (estado.activo) programarFotograma();
  };

  // requestVideoFrameCallback se dispara por fotograma real: no gasta batería
  // analizando el mismo cuadro cuando el celular está quieto.
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(paso);
  else setTimeout(paso, 200);
}

async function intentarLectura(video) {
  if (!estado.lector || video.readyState < 2 || !video.videoWidth) return;

  const inicio = performance.now();
  let hallados = [];

  hallados = await estado.lector.detectar(video);

  if (!hallados.length && $('#chk-banda').checked) {
    hallados = await estado.lector.detectar(recortar(video, REGION_BANDA));
  }

  if (!hallados.length) return;

  const milisegundos = Math.round(performance.now() - inicio);
  registrarLectura(hallados[0].texto, hallados[0].formato, milisegundos);
}

// ─────────────────────────────────────────────────────────────
// 6. RESULTADOS
// ─────────────────────────────────────────────────────────────

/** Traduce un código leído a su significado, si es uno de los códigos de prueba. */
function describir(texto) {
  const conocido = CODIGOS_DE_PRUEBA.find((c) => c.texto === texto);
  return conocido ? `${conocido.etiqueta} — ${conocido.nota}` : null;
}

function registrarLectura(textoCrudo, formato, milisegundos) {
  const texto = String(textoCrudo ?? '').trim();
  if (!texto) return;

  const ahora = performance.now();
  const repetido = estado.ultima.texto === texto && ahora - estado.ultima.t < 1600;

  if (repetido) {
    estado.ultima.veces += 1;
    estado.ultima.t = ahora;
    pintarUltima(milisegundos);
    return;
  }

  estado.ultima = { texto, t: ahora, veces: 1 };
  pintarUltima(milisegundos);

  const fila = crear('li', {}, [
    crear('span', { clase: 'c', texto }),
    crear('span', { clase: 'f', texto: `${formato ?? '?'} · ${milisegundos} ms · ${new Date().toLocaleTimeString('es-MX')}` }),
  ]);
  $('#lecturas').prepend(fila);

  avisar();
}

function pintarUltima(milisegundos) {
  const caja = $('#ultimaLectura');
  const { texto, veces } = estado.ultima;
  const sentido = describir(texto);

  caja.className = 'flash';
  caja.replaceChildren(
    crear('div', { clase: 'codigo', texto }),
    crear('div', {
      clase: 'meta',
      texto:
        `${estado.lector?.tipo === 'nativo' ? 'BarcodeDetector' : 'ZXing-WASM'} · ${milisegundos} ms` +
        (veces > 1 ? ` · leído ${veces} veces` : '') +
        (sentido ? ` · ${sentido}` : ''),
    }),
  );

  // Reinicia la animación para que el destello se vea en cada lectura distinta.
  requestAnimationFrame(() => caja.classList.remove('flash'));
}

let contextoAudio = null;

function avisar() {
  if (!$('#chk-sonido').checked) return;
  navigator.vibrate?.(60);
  try {
    contextoAudio ??= new (window.AudioContext ?? window.webkitAudioContext)();
    const osc = contextoAudio.createOscillator();
    const ganancia = contextoAudio.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1180;
    ganancia.gain.setValueAtTime(0.0001, contextoAudio.currentTime);
    ganancia.gain.exponentialRampToValueAtTime(0.2, contextoAudio.currentTime + 0.01);
    ganancia.gain.exponentialRampToValueAtTime(0.0001, contextoAudio.currentTime + 0.13);
    osc.connect(ganancia);
    ganancia.connect(contextoAudio.destination);
    osc.start();
    osc.stop(contextoAudio.currentTime + 0.14);
  } catch {
    /* sin sonido: no es motivo para fallar */
  }
}

// ─────────────────────────────────────────────────────────────
// 7. CÓDIGOS DE PRUEBA (se dibujan y se leen solos)
// ─────────────────────────────────────────────────────────────

async function generarYLeerCodigos() {
  const contenedor = $('#hoja-codigos');
  contenedor.replaceChildren();

  if (!hayBwip()) {
    contenedor.append(crear('p', { clase: 'ayuda', texto: 'No se pudo cargar bwip-js: hace falta internet la primera vez.' }));
    return;
  }

  let lector;
  try {
    lector = await crearLector();
  } catch (error) {
    contenedor.append(crear('p', { clase: 'ayuda', texto: `No se puede leer sin un decodificador: ${error.message}` }));
    return;
  }

  for (const definicion of CODIGOS_DE_PRUEBA) {
    const lienzo = crear('canvas');
    const veredicto = crear('div', { clase: 'veredicto pendiente', texto: 'dibujando…' });
    const caja = crear('div', { clase: 'codigo-prueba' }, [
      crear('div', { clase: 'titulo', texto: `${definicion.etiqueta} · ${definicion.texto}` }),
      crear('div', { clase: 'nota', texto: definicion.nota }),
      lienzo,
      veredicto,
    ]);
    contenedor.append(caja);

    try {
      window.bwipjs.toCanvas(lienzo, {
        bcid: definicion.bcid,
        text: definicion.texto,
        scale: 4,
        height: definicion.bcid === 'ean13' || definicion.bcid === 'code128' ? 22 : undefined,
        includetext: false,
        // Zona blanca alrededor: sin ella, un EAN-13 no se lee ni en el mejor lector.
        paddingwidth: 14,
        paddingheight: 14,
      });
    } catch (error) {
      veredicto.className = 'veredicto mal';
      veredicto.textContent = `no se pudo dibujar: ${error.message}`;
      continue;
    }

    try {
      const resultados = await lector.detectar(lienzo);
      const leido = resultados[0]?.texto;
      if (leido === definicion.texto) {
        veredicto.className = 'veredicto ok';
        veredicto.textContent = `✓ leído correctamente con ${lector.detalle.split(' · ')[0]}`;
      } else if (leido) {
        veredicto.className = 'veredicto mal';
        veredicto.textContent = `✗ leyó algo distinto: "${leido}"`;
      } else {
        veredicto.className = 'veredicto mal';
        veredicto.textContent = '✗ el decodificador no encontró nada en esta imagen';
      }
    } catch (error) {
      veredicto.className = 'veredicto mal';
      veredicto.textContent = `✗ error al decodificar: ${error.message}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────────────────────────

async function iniciar() {
  // Se consultan los formatos soportados ANTES de pintar las casillas, para que
  // una casilla de un formato que este navegador no trae salga deshabilitada en
  // lugar de marcar una promesa que no se puede cumplir.
  if (hayBarcodeDetector()) {
    try {
      estado.formatosNativos = await window.BarcodeDetector.getSupportedFormats();
    } catch {
      /* sin lista: se asume que todo está soportado */
    }
  }

  pintaInsignias();
  pintaAvisos();
  pintaFormatos();
  pintaQr();

  $('#btn-encender').addEventListener('click', encenderCamara);
  $('#btn-apagar').addEventListener('click', apagarCamara);
  $('#btn-regenerar').addEventListener('click', generarYLeerCodigos);
  $('#btn-imprimir').addEventListener('click', () => window.print());

  $('#btn-copiar').addEventListener('click', async () => {
    const texto = ENTORNO.urlCertificado ?? location.origin;
    try {
      await navigator.clipboard.writeText(texto);
      $('#btn-copiar').textContent = 'Copiado ✓';
    } catch {
      $('#btn-copiar').textContent = 'Copia a mano';
    }
    setTimeout(() => ($('#btn-copiar').textContent = 'Copiar dirección'), 1500);
  });

  // Si ya hay permiso concedido, se puede encender sola (es lo que quieres al
  // llegar a la página desde el celular). Si no, el botón está ahí mismo.
  if (window.isSecureContext && navigator.permissions?.query) {
    try {
      const permiso = await navigator.permissions.query({ name: 'camera' });
      if (permiso.state === 'granted') encenderCamara();
    } catch {
      /* da igual: queda el botón */
    }
  }

  generarYLeerCodigos();
  pintaDiagnostico();
}

iniciar();
