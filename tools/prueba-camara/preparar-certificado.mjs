#!/usr/bin/env node
/**
 * GENERA EL CERTIFICADO LOCAL — sin recordar los argumentos de mkcert.
 *
 * El problema que resuelve: la cámara del navegador exige HTTPS con un
 * certificado VÁLIDO, y un certificado válido para la IP de tu red local
 * tiene que incluir esa IP. La IP cambia cuando reinicias el módem, y entonces
 * el certificado deja de servir sin que te enteres de por qué.
 *
 * Este script averigua la IP, la mete en el certificado y deja todo listo.
 *
 * Uso:  node tools/prueba-camara/preparar-certificado.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const DIR_CERTS = join(AQUI, 'certs');

const CON_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const pintar = (c, t) => (CON_COLOR ? `\x1b[${c}m${t}\x1b[0m` : t);
const negrita = (t) => pintar('1', t);
const tenue = (t) => pintar('2', t);
const verde = (t) => pintar('32', t);
const rojo = (t) => pintar('31', t);
const ambar = (t) => pintar('33', t);

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

function ejecutarMkcert(argumentos, opciones = {}) {
  return execFileSync('mkcert', argumentos, {
    encoding: 'utf8',
    shell: true,
    stdio: opciones.silencioso ? 'pipe' : 'inherit',
  });
}

// ─────────────────────────── comprobaciones ───────────────────────────

const interfaz = ipDeLan();
if (!interfaz) {
  console.error(`\n  ${rojo('✗')} No se encontró ninguna IP de red local. Conéctate a una wifi o por cable.\n`);
  process.exit(1);
}
const ip = interfaz.ip;

// Validación estricta antes de interpolar en un comando de shell.
const octetos = ip.split('.').map(Number);
const ipValida = octetos.length === 4 && octetos.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
if (!ipValida) {
  console.error(`\n  ${rojo('✗')} La IP detectada no es válida: "${ip}"\n`);
  process.exit(1);
}

let versionMkcert;
try {
  versionMkcert = ejecutarMkcert(['-version'], { silencioso: true }).trim();
} catch {
  console.error(`
  ${rojo('✗')} No se encontró ${negrita('mkcert')} en esta computadora.

  mkcert es la herramienta que crea un certificado local que el celular sí acepta.
  Se instala una sola vez. En Windows, cualquiera de estas funciona:

      ${negrita('winget install FiloSottile.mkcert')}      ${tenue('(recomendado)')}
      choco install mkcert
      scoop install mkcert

  Después de instalarlo, cierra y vuelve a abrir la terminal, y corre otra vez:

      ${negrita('pnpm certificado')}

  Alternativa: descarga el .exe de https://github.com/FiloSottile/mkcert/releases
  y ponlo en una carpeta que esté en el PATH.
`);
  process.exit(1);
}

console.log('');
console.log(`  ${negrita('CERTIFICADO LOCAL PARA LA PRUEBA DE LA CÁMARA')}`);
console.log(`  ${tenue('─'.repeat(52))}`);
console.log(`  ${tenue('mkcert')}           ${versionMkcert}`);
console.log(`  ${tenue('Red')}              ${interfaz.nombre} · ${verde(ip)}`);
console.log('');

// ─────────────────────────── ejecución ───────────────────────────

console.log(`  ${negrita('1/2')} Instalando la autoridad certificadora local…`);
console.log(`      ${tenue('(Windows puede pedir permiso de administrador: es normal, una sola vez)')}`);
try {
  ejecutarMkcert(['-install']);
} catch {
  console.error(`\n  ${rojo('✗')} Falló "mkcert -install". Vuelve a correr el script aceptando el permiso de administrador.\n`);
  process.exit(1);
}

mkdirSync(DIR_CERTS, { recursive: true });
const rutaCert = join(DIR_CERTS, 'local.pem');
const rutaLlave = join(DIR_CERTS, 'local-key.pem');

console.log(`\n  ${negrita('2/2')} Generando el certificado para ${verde(ip)}…`);
try {
  ejecutarMkcert([
    '-cert-file', `"${rutaCert}"`,
    '-key-file', `"${rutaLlave}"`,
    '127.0.0.1',
    '::1',
    ip,
    'localhost',
  ]);
} catch {
  console.error(`\n  ${rojo('✗')} Falló la generación del certificado.\n`);
  process.exit(1);
}

// ─────────────────────────── instrucciones ───────────────────────────

let raizCa = '(no se pudo detectar)';
try {
  raizCa = ejecutarMkcert(['-CAROOT'], { silencioso: true }).trim();
} catch {
  /* se queda el texto por defecto */
}

console.log('');
console.log(`  ${verde('✓')} Certificado creado:`);
console.log(`      ${tenue(rutaCert)}`);
console.log(`      ${tenue(rutaLlave)}`);
console.log(`      ${tenue('(la carpeta certs/ está en .gitignore: nunca se sube al repositorio)')}`);
console.log('');
console.log(`  ${negrita('Autoridad certificadora (CA):')}`);
console.log(`      ${join(raizCa, 'rootCA.pem')}`);
console.log('');
console.log(`  ${negrita('Siguiente paso')}`);
console.log(`      ${negrita('pnpm camara')}`);
console.log('');
console.log(`  Levanta los dos servidores y te dice la dirección exacta que debes abrir`);
console.log(`  en el celular. El certificado se instala desde el servidor ${tenue('http')}, sin`);
console.log(`  cables ni correo: el celular entra, descarga la CA y la instala.`);
console.log('');
if (!existsSync(rutaCert)) {
  console.error(`  ${ambar('!')} No se encontró el certificado recién generado. Revisa el mensaje de mkcert.\n`);
  process.exit(1);
}
