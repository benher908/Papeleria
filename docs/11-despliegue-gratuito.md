# 11 — Despliegue 100 % gratuito (para probar)

Respuesta corta: **sí, se puede probar todo el sistema sin pagar nada.** Incluso el escaneo con el celular. Pero hay un matiz al final que conviene saber desde ahora.

## 1. Qué significa "gratis" aquí

El sistema tiene 5 piezas. Cada una tiene una versión gratuita:

| Pieza | Versión gratis | Límite real |
|-------|----------------|-------------|
| **App + base de datos local** | El PC y el celular que ya tienes | Ninguno. No es un servicio, es tu hardware |
| **HTTPS para la cámara** | `mkcert` (LAN) o `cloudflared` (túnel) | Ninguno. Para siempre |
| **API / servidor** | El propio PC (expuesto con el túnel) | El PC tiene que estar encendido |
| **Postgres en la nube** (opcional) | Neon free tier / Oracle Always Free | ~0.5 GB. Nunca lo llenas con una papelería |
| **Respaldo en la nube** | Google Drive 15 GB gratis (con `rclone`) | 15 GB. Tus datos son < 500 MB en 5 años |
| **Dominio** | DuckDNS (`tunegocio.duckdns.org`) o el URL del túnel | Gratis para siempre |
| **Monitoreo** | UptimeRobot + healthchecks.io | Planes gratuitos suficientes |
| **Total** | **$0 / mes** | — |

**Lo único que de verdad no tiene versión gratis ilimitada es un servidor siempre encendido y confiable.** Y con la arquitectura local-first de este proyecto, eso es una pieza *opcional* durante las pruebas, porque **la caja la hace el PC, no el servidor**.

## 2. Receta A — Todo local (la más simple, y la que usarás el 90 % del tiempo)

```text
┌─────────────────────────── PC del mostrador ───────────────────────────┐
│  pnpm dev                                                               │
│   ├── PWA              http://localhost:5173   ← cámara OK en localhost │
│   ├── API local        http://localhost:4000                            │
│   └── Postgres         Docker :5432            ← 100 % gratis           │
└─────────────────────────────────────────────────────────────────────────┘
```

```bash
# 1. Postgres local con Docker (gratis, para siempre)
docker run -d --name papeleria-db \
  -e POSTGRES_DB=papeleria -e POSTGRES_USER=papeleria -e POSTGRES_PASSWORD=dev \
  -p 5432:5432 -v pgdata:/var/lib/postgresql/data postgres:16-alpine

# 2. La app
pnpm install
pnpm dev
```

**Qué puedes probar así:** absolutamente todo el núcleo (catálogo, códigos de barras, etiquetas, POS, cobro, ticket, arqueo, inventario, conteo) **y el escáner HID**.

**Qué NO puedes probar así:** la **cámara del celular**. Y aquí está el detalle que importa:

> **`http://localhost` es contexto seguro** → la cámara funciona en la PC.
> **`https://localhost`** o `http://localhost` en **el celular** apunta al celular, no a tu PC. Para usar la cámara del celular **necesitas HTTPS**, sin excepción ([04 §2](04-escaneo-movil.md#2-el-gotcha-que-hace-fracasar-el-80-de-estos-proyectos)).

## 3. Receta B — Celular con cámara, gratis y en LAN (`mkcert`)

La forma de tener HTTPS **sin internet** y sin pagar nada.

```powershell
# 1. Instala mkcert (una vez)
winget install FiloSottile.mkcert
# (o: choco install mkcert)

# 2. Crea la CA local y confíala en Windows
mkcert -install

# 3. ⭐ Emite el certificado incluyendo LA IP DE TU LAN en el SAN
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
       Select-Object -First 1).IPAddress
Write-Host "Tu IP en la LAN es: $ip"

New-Item -ItemType Directory -Force -Path certs | Out-Null
mkcert -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem `
       $ip papeleria.local localhost 127.0.0.1
```

```ts
// apps/web/vite.config.ts — Vite sirve HTTPS en la LAN
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',                       // ⭐ escucha en la LAN, no solo en localhost
    port: 5173,
    https: {
      cert: readFileSync('certs/dev-cert.pem'),
      key:  readFileSync('certs/dev-key.pem'),
    },
  },
});
```

```powershell
# 4. La CA que hay que instalar en el celular:
mkcert -CAROOT      # → C:\Users\benki\AppData\Local\mkcert\rootCA.pem
# Pásala al celular (USB, correo, o un archivo compartido)
```

**Instalar la CA en el celular (una sola vez):**

| Android | iOS |
|---------|-----|
| Ajustes → Seguridad → Cifrado y credenciales → **Instalar un certificado** → **Certificado de CA** → elige `rootCA.pem` | 1. Ajustes → General → VPN y dispositivo → **Instalar perfil** |
| ⚠️ Android 11+ **exige** hacerlo desde Ajustes, no desde el navegador | 2. ⚠️ **Y ADEMÁS**: Ajustes → General → **Información** → **Confianza en certificados** → activar |
| Usa **Chrome** (confía en CAs de usuario) | 3. Cierra y abre Safari |

**El paso 2 de iOS es el que todos se saltan.** Son **dos** habilitaciones, no una.

Luego en el celular abres:

```text
https://192.168.1.50:5173/scan
```

Y la cámara funciona, sin internet, sin servidor, sin pagar nada. **Este es el equivalente gratuito de la "VÍA B" del documento [09](09-despliegue-y-costos.md#3-https-en-la-lan-el-problema-difícil-ya-resuelto).**

> **Nota sobre `@vitejs/plugin-basic-ssl`:** es más rápido de configurar (una línea), pero emite un certificado autofirmado **sin CA instalada**. Chrome muestra advertencia y el contexto seguro queda en un limbo: **puede bloquear la cámara y los service workers**. Sirve para "ver que carga la página", no para validar el escaneo. Usa `mkcert` bien instalado.

## 4. Receta C — Acceso desde fuera de tu local, gratis (túnel)

¿Quieres usar el celular desde tu casa, o probar el "ver reportes desde fuera"? Sin VPS y sin pagar:

### Cloudflare Tunnel rápido (sin cuenta, sin tarjeta)

```powershell
winget install Cloudflare.cloudflared

# Con la API local corriendo en el PC:
cloudflared tunnel --url http://localhost:4000

# → Cloudflare imprime algo como:
#   https://silly-blue-cat-1234.trycloudflare.com
```

**Eso es un HTTPS real, con certificado de Cloudflare, apuntando a tu PC. Gratis, sin cuenta, sin abrir puertos en el router, sin IP pública.**

| ✅ Ventaja | ❌ Límite |
|-----------|-----------|
| HTTPS válido, la cámara funciona | El URL **cambia cada vez que reinicias** |
| **Soporta WebSocket** (el escáner funciona) | Requiere internet |
| No abres puertos (el túnel sale hacia fuera) | Expone tu servidor local a internet → **debe tener login** |
| Sin cuenta, sin tarjeta | No sirve si se cae tu internet |

```bash
# Alternativa: ngrok
ngrok http 4000
```

> **ngrok free agrega una página intermedia de advertencia** antes de llegar a tu app. Eso **rompe los WebSockets y la instalación de la PWA**, y es una razón concreta para preferir `cloudflared` para este proyecto. `trycloudflare` no muestra esa página.

### Dominio estable con túnel (cuenta gratis de Cloudflare)

Si quieres un URL fijo (`papeleria.midominio.com`) y no solo el aleatorio:

1. Compra un dominio barato: **`.xyz` / `.site` salen $1–3 USD el primer año** (Cloudflare Registrar, Namecheap, Porkbun). O usa **DuckDNS** gratis (`tunegocio.duckdns.org`) si aceptas que el dominio sea `duckdns.org`.
2. Crea una cuenta gratis en Cloudflare y apunta el dominio a sus nameservers.
3. Conecta el túnel:

```powershell
cloudflared tunnel login
cloudflared tunnel create papeleria
cloudflared tunnel route dns papeleria papeleria.midominio.com
cloudflared tunnel run --url http://localhost:4000 papeleria
```

Y el URL ya no cambia. **Sigue siendo $0/mes** (más el dominio si lo compras).

> **DuckDNS + Cloudflare Tunnel no se llevan bien:** Cloudflare exige que el dominio use **sus** nameservers, y un subdominio `duckdns.org` no se puede mover. Si quieres dominio gratis con túnel, usa el `trycloudflare` aleatorio o compra el dominio de $1–3. Si quieres dominio gratis **estable** con un VPS gratis, sí sirve DuckDNS (Receta D).

## 5. Receta D — Servidor 24/7 gratis (opcional, cuando quieras probar la sincronización real)

Para probar `push`/`pull` de verdad necesitas **algo** encendido aparte del PC. Opciones genuinamente gratis:

| Opción | Qué te da | Ojo con |
|--------|-----------|---------|
| **Oracle Cloud Always Free** | 4 vCPU ARM + 24 GB RAM **para siempre** | El registro es tedioso (a veces rechaza tarjetas) y **reclama instancias ociosas**. Perfecto para pruebas, no para el respaldo primario de tu negocio |
| **Google Cloud free tier (e2-micro)** | 1 instancia `e2-micro` gratis **para siempre** en regiones de EE. UU. | 1 GB de RAM y 30 GB de disco. Suficiente y sobra |
| **AWS free tier** | 12 meses | **Deja de ser gratis** y la factura sorpresa es un clásico |
| **Render / Railway / Koyeb free** | Contenedores gratis | ⚠️ **Se duermen** por inactividad (30–60 s para despertar). Aceptable para `/sync/push` de vez en cuando, **malo** para el WebSocket del escáner |
| **Neon free tier** (Postgres) | Base de datos Postgres serverless | 0.5 GB, escala a cero (despierta en ~1 s). No lo uses para el WebSocket |
| **Supabase free** | Postgres + API + Auth | ⚠️ **Pausa el proyecto tras 1 semana de inactividad**. Malo para un negocio, dudoso para pruebas |

**Configuración gratuita recomendada para probar la sincronización:**

```text
Oracle Always Free (o GCP e2-micro)   →  $0
   ├── Docker: Caddy + API + Postgres
   ├── Dominio: tunegocio.duckdns.org  (gratis, con actualizador DDNS)
   └── Caddy emite el certificado con el reto DNS-01 de DuckDNS
                (gratis, no necesita que la IP sea pública ni el puerto 80 abierto)
```

```caddyfile
# Caddyfile con dominio gratis de DuckDNS (reto DNS-01)
# Requiere: el plugin de DNS de DuckDNS en Caddy, y el token de DuckDNS.
papeleria-midominio.duckdns.org {
    tls {
        dns duckdns {env.DUCKDNS_TOKEN}
    }
    encode zstd gzip
    root * /srv/web
    handle /assets/* { file_server }
    handle { try_files {path} /index.html }
    handle /api/* { uri strip_prefix /api; reverse_proxy api:4000 }
    handle /ws/*  { reverse_proxy api:4000 }
}
```

**¿Por qué el reto DNS-01 y no HTTP-01?** Porque con DuckDNS no controlas el puerto 80 ni tienes que tener IP pública: el certificado se valida creando un registro TXT en el DNS. **Es la única forma de tener un certificado válido con dominio gratis en un servidor casero.**

## 6. Respaldos gratis (lo único no negociable)

Aunque todo lo demás sea gratis, **los respaldos no se omiten**. Y son gratis:

```powershell
# 1. rclone con Google Drive (15 GB gratis)
winget install Rclone.Rclone
rclone config     # → nuevo remoto 'gdrive' → tipo 'drive'

# 2. En scripts/backup.ps1, la línea que ya existe en el doc 07 ya los sube:
rclone copy "D:\respaldos\papeleria" "gdrive:papeleria-respaldos"
```

**Y haz que te avise.** El error más caro es un respaldo que deja de funcionar y nadie nota:

```powershell
# healthchecks.io — plan gratis (20 monitores, alertas por correo/Telegram)
# Al final del script de respaldo:
Invoke-WebRequest -Uri "https://hc-ping.com/TU-UUID-AQUI" -UseBasicParsing
# Y si falla, avisa al endpoint /fail → te llega un correo:
```

| Servicio | Gratis | Para qué |
|----------|--------|----------|
| **healthchecks.io** | 20 monitores | ⭐ Monitoreo de *cron*: si el respaldo no corre, te avisa. Es exactamente lo que necesitas |
| **UptimeRobot** | 50 monitores | ¿Responde la API? Cada 5 min |
| **Google Drive** | 15 GB | El destino del respaldo |
| **Backblaze B2** | 10 GB | Alternativa, ~$0.30/mes si te pasas |
| **Telegram Bot** | ∞ | Alertas push gratis al celular |

Con los respaldos cubiertos, **ya puedes probar el sistema completo en producción de prueba sin gastar un peso.**

## 7. El matiz: cuándo dejar de ser gratis

Si todo esto es gratis, ¿por qué el documento [09](09-despliegue-y-costos.md) recomienda pagar $6 al mes? Porque **lo barato sale caro en un negocio en marcha**:

| Síntoma de que ya tienes que pagar | Por qué |
|------------------------------------|---------|
| Llevas **más de 1 semana vendiendo de verdad** con el sistema | Ya hay datos que no puedes perder |
| El URL aleatorio del túnel te molesta o se cae | Fricción diaria |
| El plan gratis **se duerme** y la caja tarda 40 s | Inaceptable en hora pico |
| El proveedor gratis puede **suspender tu cuenta por inactividad** | Es el respaldo de tu negocio, no un hobby |
| Quieres passkeys (necesitan dominio propio) | Seguridad sin fricción |
| Ya invertiste $75 en UPS + lector HID | $6/mes es el 8 % de lo que ya gastaste en hardware |

**La regla pragmática:** usa las recetas gratuitas para **construir y probar** (fases 0–5 del [roadmap](10-roadmap.md)). Cuando vayas a **vender de verdad**, activa el VPS de $6 y las recetas gratuitas pasan a ser los respaldos. Son $72 al año: menos de lo que cuesta una caja de bolígrafos al mes.

Y una advertencia importante para las pruebas:

> **Mientras pruebes gratis, el Excel sigue siendo la fuente de verdad.** Es exactamente el "modo sombra" del [roadmap](10-roadmap.md#el-hito-real-de-f2). El sistema gratuito es para aprender y validar; no le confíes todavía el único registro de tus ventas.

## 8. Checklist de arranque gratuito

**Hoy mismo, sin gastar nada**
- [ ] Postgres en Docker + `pnpm dev` (Receta A) — puedes probar todo el núcleo
- [ ] Lector HID o script que simule teclado → el escaneo funciona desde el día 1
- [ ] `mkcert` con **la IP de tu LAN en el SAN** (Receta B)
- [ ] CA instalada y **confiada** en el celular (dos pasos en iOS)
- [ ] **Validar la cámara del celular** por HTTPS: es la tarea 0.9 y es la que decide el proyecto
- [ ] `cloudflared tunnel --url http://localhost:4000` → probar el acceso desde fuera de la casa
- [ ] Respaldos con `rclone` a Google Drive + `healthchecks.io`

**Cuando quieras probar la sincronización real (una tarde)**
- [ ] Oracle Always Free o GCP `e2-micro`
- [ ] DuckDNS + Caddy con reto DNS-01
- [ ] `POST /sync/push` y `GET /sync/pull` con dos dispositivos
- [ ] Apagar el WiFi a media venta y comprobar que se sincroniza al volver

**Cuando vayas a vender de verdad**
- [ ] VPS de $5–6 con dominio propio (doc [09](09-despliegue-y-costos.md))
- [ ] Dominio con 2FA
- [ ] Prueba de restauración de respaldo **antes** del primer día en producción
