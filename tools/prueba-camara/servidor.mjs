#!/usr/bin/env node
/**
 * SERVIDOR DE PRUEBA — tarea 0.9 del roadmap (docs/10-roadmap.md)
 *
 * Levanta DOS servidores a propósito:
 *
 *   · HTTPS en :8443  →  la prueba de la cámara y los códigos
 *   · HTTP  en :8080  →  página para instalar el certificado en el celular
 *
 * El segundo parece redundante. No lo es: separa dos fallas que siempre se
 * confunden en una sola queja ("no funciona"):
 *
 *     si el celular NO abre  http://IP:8080   →  es la RED o el FIREWALL de Windows
 *     si SÍ abre :8080 pero falla :8443       →  es el CERTIFICADO
 *
 * Sin esta separación, "no funciona" no te dice cuál de las dos cosas arreglar,
 * y vas a terminar reinstalando certificados cuando el problema era el firewall.
 *
 * Cero dependencias. Node 22+.
 *
 * Uso:  node tools/prueba-camara/servidor.mjs [puertoHttps] [puertoHttp]
 */

import { createServer as crearHttps } from 'node:https';
import { createServer as crearHttp } from 'node:http';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ejecutarMkcert } from './mkcert.mjs';

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const PUBLICO = join(AQUI, 'public');
const DIR_CERTS = join(AQUI, 'certs');

const PUERTO_HTTPS = Number(process.env.PUERTO ?? process.argv[2] ?? 8443);
const PUERTO_HTTP = Number(process.env.PUERTO_HTTP ?? process.argv[3] ?? 8080);

// ─────────────────────────────── color ───────────────────────────────
const CON_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const pintar = (codigo, texto) => (CON_COLOR ? `\x1b[${codigo}m${texto}\x1b[0m` : texto);
const negrita = (t) => pintar('1', t);
const tenue = (t) => pintar('2', t);
const verde = (t) => pintar('32', t);
const rojo = (t) => pintar('31', t);
const ambar = (t) => pintar('33', t);
const cian = (t) => pintar('36', t);

// ────────────────────────── red y certificado ──────────────────────────

/** La IP de la LAN, saltándose interfaces virtuales (WSL, Docker, VirtualBox). */
function ipDeLan() {
  const candidatas = [];
  for (const [nombre, direcciones] of Object.entries(networkInterfaces())) {
    for (const d of direcciones ?? []) {
      if (d.family === 'IPv4' && !d.internal) candidatas.push({ nombre, ip: d.address });
    }
  }
  const virtual = /wsl|vethernet|virtualbox|vmware|hyper-?v|docker|loopback|tailscale|zerotier/i;
  candidatas.sort((a, b) => Number(virtual.test(a.nombre)) - Number(virtual.test(b.nombre)));
  return candidatas[0] ?? null;
}

function buscarCertificado() {
  if (process.env.CERT && process.env.KEY) return { cert: process.env.CERT, key: process.env.KEY, origen: 'variables CERT y KEY' };

  if (!existsSync(DIR_CERTS)) return null;
  const archivos = readdirSync(DIR_CERTS);
  const cert = archivos.find((f) => /\.(pem|crt|cer)$/i.test(f) && !/key/i.test(f));
  const key = archivos.find((f) => /(key|privada).*\.(pem|key)$/i.test(f) || /-key\.pem$/i.test(f));
  if (cert && key) return { cert: join(DIR_CERTS, cert), key: join(DIR_CERTS, key), origen: DIR_CERTS };
  return null;
}

/** Lee el certificado y comprueba si de verdad cubre la IP actual. */
function inspeccionarCertificado(rutaCert, ip) {
  try {
    const cert = new X509Certificate(readFileSync(rutaCert));
    const sans = (cert.subjectAltName ?? '').replace(/\s+/g, ' ');
    const fechas = new Date(cert.validTo);
    const cubreIp = sans
      .split(/,\s*/)
      .some((parte) => {
        const coincidencia = /^IP Address:\s*(.+)$/i.exec(parte.trim());
        return coincidencia ? coincidencia[1].trim() === ip : false;
      });

    return {
      sujeto: (cert.subject ?? '').replace(/\n/g, ', ') || '—',
      vence: Number.isNaN(fechas.getTime()) ? cert.validTo : fechas.toISOString(),
      venceTexto: Number.isNaN(fechas.getTime()) ? cert.validTo : fechas.toLocaleDateString('es-MX'),
      sans: sans || '—',
      cubreIp,
    };
  } catch (error) {
    return { error: `No se pudo leer ${rutaCert}: ${error.message}` };
  }
}

/** La CA raíz de mkcert, para que el celular pueda descargarla por http. */
function rutaRaizDeMkcert() {
  try {
    const ruta = join(ejecutarMkcert(['-CAROOT'], { silencioso: true }).trim(), 'rootCA.pem');
    return existsSync(ruta) ? ruta : null;
  } catch {
    // O no hay mkcert, o no está instalada la CA todavía. Da igual: la página de
    // instalación ya explica ese caso, y el servidor arranca sin esa comodidad.
    return null;
  }
}

// ────────────────────────── servidor de archivos ──────────────────────────

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function rutaDeArchivo(rutaUrl) {
  let decodificada;
  try {
    decodificada = decodeURIComponent(rutaUrl.split('?')[0]);
  } catch {
    return null;
  }
  const relativa = decodificada === '/' ? 'index.html' : decodificada.replace(/^[/\\]+/, '');
  const absoluta = join(PUBLICO, relativa);
  // Defensa contra ../ : el archivo tiene que quedar dentro de public/
  if (!absoluta.startsWith(PUBLICO)) return null;
  return absoluta;
}

function registrarSolicitud(req, etiqueta) {
  const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
  console.log(`  ${tenue(etiqueta)} ${tenue(ip.padEnd(15))} ${req.method} ${req.url}`);
}

function servirEstatico(req, res, inyectar) {
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const archivo = rutaDeArchivo(req.url ?? '/');
  if (!archivo || !existsSync(archivo)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 — no existe ${req.url}`);
    return;
  }

  const extension = extname(archivo).toLowerCase();
  let cuerpo = readFileSync(archivo);

  if (extension === '.html') {
    let html = cuerpo.toString('utf8');
    if (inyectar && html.includes('<!--ENTORNO-->')) html = html.replace('<!--ENTORNO-->', inyectar());
    cuerpo = Buffer.from(html, 'utf8');
  }

  res.writeHead(200, {
    'Content-Type': TIPOS[extension] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(cuerpo);
}

// ────────────────────────── página de instalación ──────────────────────────

function paginaInstalacion({ ip, urlCamara, hayCa }) {
  const urlCa = `http://${ip}:${PUERTO_HTTP}/ca`;
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instalar el certificado — Papelería</title>
<style>
  body { margin:0; padding:20px 16px 60px; font:17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:#10161f; background:#f2f4f7; }
  .caja { max-width:640px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .sub { color:#5b6675; font-size:.92rem; margin:0 0 20px; }
  .tarjeta { background:#fff; border:1px solid #d3d9e2; border-radius:10px; padding:18px; margin-bottom:16px; }
  .ok { background:#e6f4ea; border-color:#b7dfc5; }
  a.boton { display:block; text-align:center; background:#1c5fd4; color:#fff; text-decoration:none;
            font-weight:600; padding:15px; border-radius:10px; margin:14px 0 6px; }
  a.boton.sec { background:#fff; color:#1c5fd4; border:1px solid #1c5fd4; }
  ol,ul { padding-left:22px; }
  li { margin-bottom:9px; }
  code { font-family:ui-monospace,Consolas,monospace; font-size:.88em; background:#f2f4f7; padding:2px 6px; border-radius:4px; }
  .clave { background:#fdf2d9; border:1px solid #ecd39a; border-radius:8px; padding:12px 14px; margin-top:14px; font-size:.92rem; }
  h2 { font-size:1.02rem; margin:22px 0 8px; }
</style>
</head><body>
<div class="caja">
  <h1>Paso 1 · Instalar el certificado</h1>
  <p class="sub">Si estás viendo esta página desde el celular, la red y el firewall están bien. Ahora falta que el teléfono confíe en el certificado.</p>

  <div class="tarjeta ${hayCa ? 'ok' : ''}">
    ${hayCa
      ? `<strong>El celular YA puede llegar a esta computadora.</strong> Falta un solo paso antes de la cámara:`
      : `<strong>No se encontró la autoridad certificadora de mkcert.</strong> Corre primero <code>pnpm certificado</code> en la computadora; después vuelve a cargar esta página.`}
    ${hayCa ? `<a class="boton" href="/ca" download="papeleria-ca.crt">Descargar el certificado</a>` : ''}
  </div>

  <div class="tarjeta">
    <h2>Android</h2>
    <ol>
      <li>Toca <strong>Descargar el certificado</strong> arriba.</li>
      <li>Abre <strong>Ajustes</strong> → <strong>Seguridad</strong> (o <em>Seguridad y privacidad</em>) → <strong>Cifrado y credenciales</strong> → <strong>Instalar un certificado</strong> → <strong>Certificado de CA</strong>.</li>
      <li>Elige el archivo descargado (<code>papeleria-ca.crt</code>). Puede pedirte el PIN o patrón del teléfono.</li>
      <li>Acepta el aviso de que «una aplicación podría vigilar tu tráfico». Es tu propio certificado local, no de un tercero.</li>
    </ol>

    <h2>iPhone / iPad</h2>
    <ol>
      <li>Toca <strong>Descargar el certificado</strong> y acepta el aviso de «perfil».</li>
      <li>Abre <strong>Ajustes</strong> → <strong>General</strong> → <strong>VPN y gestión de dispositivos</strong> → toca el perfil descargado → <strong>Instalar</strong>.</li>
      <li>⚠️ <strong>Este paso es el que casi todos olvidan:</strong> ve a <strong>Ajustes</strong> → <strong>General</strong> → <strong>Información</strong> → <strong>Ajustes de confianza de certificados</strong> y <strong>activa</strong> el interruptor de <em>papeleria</em> / mkcert.</li>
    </ol>
    <div class="clave">
      En iPhone, instalar el certificado <strong>no es suficiente</strong>: hay que activarlo también en
      «Ajustes de confianza de certificados». Si te saltas ese paso, Safari sigue bloqueando la cámara
      y parece que el certificado no sirviera.
    </div>
  </div>

  <div class="tarjeta">
    <h2>Paso 2 · Probar la cámara</h2>
    <p class="sub" style="margin:0 0 10px">Ya con el certificado instalado:</p>
    <a class="boton sec" href="${urlCamara}">Ir a la prueba de la cámara</a>
    <p class="sub" style="margin:10px 0 0"><code>${urlCamara}</code></p>
  </div>

  <p class="sub">¿Esta página no abre desde el celular? Entonces todavía no es un problema de certificado: es la red.
  Revisa que el celular y la computadora estén en la <strong>misma</strong> red wifi (no en la de invitados) y permite Node en el firewall de Windows.</p>
</div></body></html>`;
}

// ────────────────────────── arranque ──────────────────────────

function morir(mensaje) {
  console.error(`\n  ${rojo('✗')} ${mensaje}\n`);
  process.exit(1);
}

const interfaz = ipDeLan();
if (!interfaz) morir('No se encontró ninguna IP de red local. Conéctate a una wifi o a la red por cable.');

const ip = interfaz.ip;
const certificado = buscarCertificado();
if (!certificado) {
  morir(
    `No hay certificado en ${DIR_CERTS}\n\n` +
      `  Corre esto primero, que lo genera:\n\n` +
      `      ${negrita('pnpm certificado')}\n\n` +
      `  (o pon las variables CERT y KEY con las rutas de un .pem y su llave)`,
  );
}

const info = inspeccionarCertificado(certificado.cert, ip);
if (info.error) morir(info.error);

const rutaCa = rutaRaizDeMkcert();
const urlLocal = `https://localhost:${PUERTO_HTTPS}`;
const urlCamara = `https://${ip}:${PUERTO_HTTPS}`;
const urlInstalar = `http://${ip}:${PUERTO_HTTP}`;

function scriptEntorno() {
  const datos = {
    ipLan: ip,
    interfaz: interfaz.nombre,
    puertoHttps: PUERTO_HTTPS,
    puertoHttp: PUERTO_HTTP,
    urlCamara,
    urlCertificado: urlInstalar,
    certificado: {
      sujeto: info.sujeto,
      vence: info.vence,
      sans: info.sans,
      cubreIp: info.cubreIp,
    },
  };
  return `<script>window.__ENTORNO__ = ${JSON.stringify(datos)};<\/script>`;
}

const servidorHttps = crearHttps(
  { cert: readFileSync(certificado.cert), key: readFileSync(certificado.key) },
  (req, res) => {
    registrarSolicitud(req, 'https');
    servirEstatico(req, res, scriptEntorno);
  },
);

const servidorHttp = crearHttp((req, res) => {
  registrarSolicitud(req, ' http');

  const ruta = (req.url ?? '/').split('?')[0];

  if (ruta === '/ca') {
    if (!rutaCa) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No se encontró la CA de mkcert. Corre: mkcert -CAROOT');
      return;
    }
    const pem = readFileSync(rutaCa);
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="papeleria-ca.crt"',
      'Content-Length': pem.length,
      'Cache-Control': 'no-store',
    });
    res.end(pem);
    return;
  }

  if (ruta === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const hayCa = Boolean(rutaCa);
  const html = paginaInstalacion({ ip, urlCamara, hayCa });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
});

servidorHttps.on('error', (error) => {
  if (error.code === 'EADDRINUSE') morir(`El puerto ${PUERTO_HTTPS} ya está ocupado. Usa otro: pnpm camara 8444 8081`);
  morir(`Error en el servidor HTTPS: ${error.message}`);
});

servidorHttp.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`\n  ${ambar('!')} El puerto ${PUERTO_HTTP} está ocupado: sigue sin la página de certificado.\n`);
  } else {
    console.log(`\n  ${ambar('!')} No se pudo levantar el servidor http: ${error.message}\n`);
  }
});

servidorHttps.listen(PUERTO_HTTPS, '0.0.0.0');
servidorHttp.listen(PUERTO_HTTP, '0.0.0.0');

function linea(etiqueta, valor) {
  console.log(`  ${tenue(etiqueta.padEnd(19))} ${valor}`);
}

setTimeout(() => {
  console.log('');
  console.log(`  ${negrita('PRUEBA DE CÁMARA Y CÓDIGOS DE BARRAS')}`);
  console.log(`  ${tenue('─'.repeat(52))}`);
  linea('Certificado', `${info.sujeto} · vence ${info.venceTexto}`);
  linea('Cubre la IP', info.cubreIp ? verde(`sí, incluye ${ip}`) : rojo(`NO incluye ${ip}`));
  linea('Red', `${interfaz.nombre} · ${ip}`);
  linea('Sirviendo desde', certificado.origen);
  console.log('');
  console.log(`  ${negrita('1)')} En esta computadora ${tenue('(para ver el QR y los códigos de prueba)')}`);
  console.log(`     ${cian(urlLocal)}`);
  console.log('');
  console.log(`  ${negrita('2)')} En el celular, ${negrita('en este orden')}`);
  console.log(`     ${cian(urlInstalar)}   ${tenue('← abre esto primero: instala el certificado')}`);
  console.log(`     ${cian(urlCamara)}   ${tenue('← después: la prueba de la cámara')}`);

  if (!info.cubreIp) {
    console.log('');
    console.log(`  ${rojo('El certificado no incluye ' + ip + '.')} El celular va a mostrar una advertencia`);
    console.log(`  y la cámara no funcionará. Arréglalo con:`);
    console.log(`     ${negrita('pnpm certificado')}   ${tenue('(vuelve a generarlo con la IP actual)')}`);
  }

  if (!rutaCa) {
    console.log('');
    console.log(`  ${ambar('!')} No se encontró la CA de mkcert: el celular no podrá descargarla.`);
    console.log(`     Corre ${negrita('mkcert -install')} en la computadora.`);
  }

  console.log('');
  console.log(`  ${tenue('Aquí abajo se registra cada visita. Si el celular no aparece, es la red,')}`);
  console.log(`  ${tenue('no el certificado. Ctrl+C para terminar.')}`);
  console.log('');
}, 150);

function apagar() {
  console.log(`\n  ${tenue('Cerrando servidores…')}\n`);
  servidorHttps.close();
  servidorHttp.close();
  process.exit(0);
}

process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
