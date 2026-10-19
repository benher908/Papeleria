# 09 — Despliegue, hardware y costos

## 1. Las tres topologías (y cuál elegir)

### Topología A — Solo el PC del local (todo en LAN)

```text
┌──────────────────────────────────────────┐
│  PC del mostrador                        │
│  ├── PWA (Chrome)                        │
│  ├── PGlite (IndexedDB)  ← la BD         │
│  └── API local :4321 (HTTPS con mkcert)  │
└──────────────────────────────────────────┘
        ▲ WSS en LAN
   ┌────┴─────┐
   │ Celular  │
   └──────────┘
```

| ✅ | ❌ |
|----|----|
| Cero costo mensual | **Sin respaldo fuera del PC** → un incendio/robo = pérdida total |
| Latencia ~5 ms | No puedes ver los reportes desde tu casa |
| Funciona 100 % sin internet | Sin passkeys (WebAuthn exige dominio) |
| Cero operación de servidor | Si el PC muere, no vendes hasta repararlo |

**Cuándo:** solo como arranque temporal. **Nunca** como estado final: el riesgo de perder todo no es aceptable en un negocio.

### Topología B — Solo el servidor (VPS)

```text
   PC (navegador) ──── internet ───▶ VPS (API + Postgres + Caddy)
   Celular        ──── internet ───▶
```

| ✅ | ❌ |
|----|----|
| Respaldo y acceso remoto natural | **Se cae el internet, no vendes.** Inaceptable |
| Passkeys funcionan | Latencia por red (depende del proveedor) |
| Cero mantenimiento local | Un corte del proveedor te deja sin caja |

**Cuándo:** nunca sola. Es exactamente el diseño que este proyecto evita.

### Topología C — Híbrida (recomendada) ⭐

```text
┌───────────────────────────────────────────────────────────────┐
│  PC DEL MOSTRADOR                                             │
│  ├── PWA + PGlite   ← TRABAJAS AQUÍ, siempre y sin internet   │
│  └── API local :4321 (HTTPS mkcert) ← para el celular en LAN  │
└──────────────────────────┬────────────────────────────────────┘
                           │  sincroniza cuando hay internet
                           ▼
┌───────────────────────────────────────────────────────────────┐
│  VPS ($5–6 USD/mes)                                           │
│  ├── Caddy (HTTPS automático, dominio real)                   │
│  ├── API (recepción de sync, WebSocket del escáner)           │
│  ├── PostgreSQL (verdad consolidada + respaldos)              │
│  └── Snapshots de políticas firmadas                          │
└──────────────────────────┬────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
       📱 Celular (desde           💻 Tu casa (reportes,
          cualquier lugar)            solo lectura)
```

**Por qué gana:**

- **Vendes sin internet** (la caja es local) — el requisito duro.
- **Tienes respaldo real** fuera del local — el riesgo que sí importa.
- **Ves el negocio desde casa** y el celular funciona aunque estés fuera del local.
- **Passkeys disponibles** (hay un dominio real).
- **6 USD/mes.** Menos que una caja de bolígrafos al mes.

### Matriz de fallas: qué pasa cuando algo se rompe

| Falla | ¿Puedes vender? | ¿Se pierde algo? | Recuperación |
|-------|:---:|:---:|--------------|
| **Se cae el internet** | ✅ Sí, todo local | No | Sincroniza solo al volver |
| **Se cae el VPS** | ✅ Sí | No | Sync se acumula en `outbox`; se sube cuando vuelve |
| **Se cae el PC** | ❌ No | Hasta el último sync (≤ 1 día) | Restaurar el dump en otra PC; la PWA se reconecta |
| **Se va la luz** | ❌ (5–30 min) | ⚠️ La venta **en curso** (no confirmada) | **UPS** evita esto (§5). La BD no se corrompe |
| **Se roban el PC** | ❌ | Hasta 1 día; **BitLocker** protege los datos | Revocar el dispositivo, restaurar, cambiar contraseñas |
| **Se roban el celular** | ✅ Sí | Nada | Revocar el dispositivo en 5 s |
| **Se corrompe la BD local** | ⚠️ | Nada (el servidor es la verdad) | `DELETE` de IndexedDB + re-pull completo |
| **Fallan ambos** | ❌ | Hasta 1 día | Restaurar del respaldo en la nube |
| **Se borra la BD del VPS** | ✅ Sí (local) | Nada | Restaurar el último dump (≤ 1 día de sync) |

**Ninguna fila dice "pérdida total".** Ese es el objetivo del diseño. La única pérdida real posible es el último día de sincronización, y solo si **el PC y el VPS fallan al mismo tiempo**.

## 2. Docker Compose del VPS

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    container_name: papeleria-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: papeleria
      POSTGRES_USER: papeleria
      POSTGRES_PASSWORD: ${DB_PASSWORD:?requerido}
    volumes:
      - dbdata:/var/lib/postgresql/data
      - ./packages/db/migrations:/docker-entrypoint-initdb.d:ro   # ⭐ el mismo esquema que PGlite
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U papeleria"]
      interval: 10s
      retries: 5
    # ⚠️ NO expongas el 5432 al mundo. Solo red interna de Docker.
    deploy:
      resources:
        limits: { memory: 512M }

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    container_name: papeleria-api
    restart: unless-stopped
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://papeleria:${DB_PASSWORD}@db:5432/papeleria
      JWT_PRIVADA_ED25519: ${JWT_PRIVADA_ED25519}
      JWT_PUBLICA_ED25519: ${JWT_PUBLICA_ED25519}
      POLITICAS_PRIVADA_ED25519: ${POLITICAS_PRIVADA_ED25519}
      ARGON2_PEPPER: ${ARGON2_PEPPER}
      DOMINIO: papeleria.midominio.com
      NODE_ENV: production
    ports:
      - "127.0.0.1:4000:4000"

  caddy:
    image: caddy:2-alpine
    container_name: papeleria-caddy
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./apps/web/dist:/srv/web:ro          # el build de la PWA
      - caddy_data:/data                      # ⭐ IMPORTANTE: guarda los certificados
      - caddy_config:/config
    depends_on: [api]

volumes:
  dbdata:
  caddy_data:
  caddy_config:
```

> **Sobre `caddy_data`:** si no lo persistes, cada reinicio de Caddy pide un certificado nuevo a Let's Encrypt. Let's Encrypt tiene un límite de 5 certificados por dominio por semana → **te quedas sin HTTPS el viernes**. Es un error clásico y molesto. El volumen es obligatorio.

```caddyfile
# Caddyfile — HTTPS automático, cero configuración de certificados
papeleria.midominio.com {
    encode zstd gzip

    # La PWA (estáticos)
    root * /srv/web
    handle /assets/* { file_server }
    handle { try_files {path} /index.html }

    # API
    handle /api/* {
        uri strip_prefix /api
        reverse_proxy api:4000
    }

    # WebSocket del escáner (Caddy pasa el upgrade automáticamente)
    handle /ws/* {
        reverse_proxy api:4000
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        # ⭐ CSP: obligatoria para la cámara; permite WASM (PGlite) y blob (bwip-js)
        Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    }
}
```

## 3. HTTPS en la LAN (el problema difícil, ya resuelto)

Recordatorio del *gotcha* del documento [04](04-escaneo-movil.md#2-el-gotcha-que-hace-fracasar-el-80-de-estos-proyectos): **la cámara exige HTTPS**. Tienes dos caminos y conviene tener los dos.

### VÍA A — El VPS (dominio real)

Ya está: Caddy + dominio. Es el camino principal y no requiere nada en el local.

### VÍA B — LAN con `mkcert`

Necesaria cuando **no hay internet** y el celular debe escanear. Tres pasos:

```powershell
# 1. Certificado con la IP de la LAN en el SAN (no solo el nombre)
mkcert -install                                   # crea la CA local
mkcert -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem `
       192.168.1.50 papeleria.local localhost 127.0.0.1

# ⚠️ El error #1 es emitir el certificado solo para 'papeleria.local' y no para
#    la IP. El celular entra por IP y el navegador rechaza el certificado
#    → vuelve a bloquear la cámara. SIEMPRE incluye la IP en el SAN.

# 2. La CA está en:
mkcert -CAROOT        # → C:\Users\benki\AppData\Local\mkcert
```

**Instalar la CA en el celular (una sola vez):**

| Android | iOS |
|---------|-----|
| 1. Pasa el `rootCA.pem` al celular (USB, correo, o un QR con el archivo) | 1. Envía el `rootCA.pem` por AirDrop o correo |
| 2. Ajustes → Seguridad → Cifrado y credenciales → **Instalar un certificado** → CA | 2. Ajustes → General → VPN y dispositivo → **Instalar perfil** |
| 3. ⚠️ Android 11+ exige hacerlo **desde Ajustes**, no desde el navegador | 3. ⚠️ **Y ADEMÁS**: Ajustes → General → **Información** → Confianza en certificados |
| 4. Usa **Chrome** (confía en CAs de usuario; algunas WebViews no) | 4. Reinicia Safari |

**El paso 3 de iOS es el que todo el mundo se salta** y luego concluye que es un error de código. Son **dos** habilitaciones en iOS, no una.

### VÍA C — DNS local (elegante si tu router lo permite)

Que el router resuelva `papeleria.midominio.com` → `192.168.1.50` dentro del local. Entonces usas **el mismo dominio y el mismo certificado de Let's Encrypt** dentro y fuera del local, sin instalar nada en el celular.

- **Cómo:** DNS del router (Pi-hole, AdGuard Home, OpenWrt, o "DNS estático" del router).
- **Requisito:** que el router permita DNS local. Muchos routers domésticos sí.
- **Ventaja:** passkeys funcionan dentro del local con el mismo dominio. Es la mejor solución si funciona.
- **Cuidado:** algunos resolvers públicos rechazan respuestas con IP privada (protección contra DNS rebinding). Con el DNS del router (que resuelve localmente) no hay problema.

```text
Orden de preferencia:
  1. VÍA C si tu router lo soporta → cero configuración en el celular, passkeys en LAN
  2. VÍA A siempre (es el camino normal)
  3. VÍA B como respaldo cuando no hay internet en absoluto
```

## 4. Elegir VPS

| Proveedor | Desde | Notas |
|-----------|-------|-------|
| **Hetzner** (CX22) | ~€4.5/mes | Mejor relación precio/rendimiento de Europa. Latencia a México ~150 ms (suficiente para sync) |
| **DigitalOcean** | $6/mes | Simple, buen panel, datacenter en EE. UU. (latencia ~50 ms a México) |
| **Fly.io** | variable | Buena red global, *free tier* recortado |
| **Oracle Cloud Free Tier** | $0 | 4 vCPU ARM + 24 GB RAM gratis **para siempre**. Generoso, pero el registro es tedioso y la cuenta se puede suspender por inactividad. Úsalo para un entorno de pruebas primero |
| **VPS local/regional (México)** | $8–15/mes | Menor latencia; vale la pena si el uso remoto es intenso |

**Especificaciones que necesitas (y que sobran):** 1–2 vCPU, 1–2 GB de RAM, 20 GB de disco. **Sobradísimo.** Postgres con 10 años de una papelería son menos de 2 GB.

**Sobre el *free tier* de Oracle:** es un cebo razonable, pero recuerda que estás poniendo el respaldo de tu negocio ahí. Un proveedor que puede cerrar tu cuenta por inactividad no es ideal para el respaldo primario. **$6 al mes es el precio de dormir tranquilo.** Si el presupuesto es absolutamente cero, úsalo, pero añade el respaldo a Google Drive.

## 5. Hardware: lista de compra con costos reales

### Imprescindible

| Artículo | Costo aprox. (USD) | Por qué |
|----------|:---:|---------|
| **PC del mostrador** | $0 (ya la tienes) | Cualquier PC de los últimos 10 años con Chrome corre PGlite y React |
| **UPS** (600–800 VA) | **$45–70** | ⭐ **El que más se subestima.** Un corte de luz a media venta, un apagón mientras sincronizas, y sobre todo la corrupción de datos por corte súbito. 10–15 minutos bastan para cerrar la venta, cerrar el turno y apagar ordenadamente. **No es un lujo, es un seguro de $50 contra perder el día** |
| **Hojas de etiquetas A4** (100 hojas) | $8 | Para las primeras 3 200 etiquetas. Empezar aquí |

### Muy recomendable (compra en la semana 2–4, no al inicio)

| Artículo | Costo aprox. (USD) | Por qué |
|----------|:---:|---------|
| **Lector de códigos Bluetooth/USB (HID)** | **$25–40** | Manos libres, ~150 ms, cero código de integración. Ver [04 §6.1](04-escaneo-movil.md#61-cómo-funciona-un-lector-hid-y-por-qué-es-un-regalo) |
| **Impresora térmica de tickets 58 mm** | $35–60 | Deja de gastar en tinta y papel; el ticket sale en 1 s. Busca modelos con **ESC/POS** (la mayoría) |
| **Impresora térmica de etiquetas** (Xprinter XP-365B, Niimbot B21) | $45–120 | Etiquetas autoadhesivas profesionales, sin tinta, rollo continuo |
| **Regulador de voltaje** | $15–30 | En muchas zonas de México la tensión fluctúa y mata fuentes de alimentación |

### Opcional (fase 3+)

| Artículo | Costo | Cuándo |
|----------|:---:|--------|
| Lector 2D (imagen) que lea QR | $45–80 | Solo si usas QR en etiquetas o listas escolares |
| Impresora de etiquetas industrial (Zebra) | $150–250 | > 500 etiquetas al día |
| Monitor secundario para la caja | $80–120 | Para cliente (muestra el precio) y para el POS |
| Cajón de dinero con apertura eléctrica | $50–90 | Cuando quieras apertura desde el sistema |
| Tableta con soporte para el mostrador | $100–180 | Si prefieres el escáner fijo en lugar del celular |

> **Prioridad de gasto:** el **UPS primero** ($50), luego el **lector HID** ($25), luego la impresora térmica de tickets. Con **$75** el sistema pasa de "funciona" a "es agradable de usar todos los días". Todo lo demás es comodidad.

## 6. Costos de operación

| Concepto | Costo mensual | Nota |
|----------|:---:|------|
| VPS | $5–6 | Hetzner/DigitalOcean |
| Dominio | ~$0.85/mes | $10/año, en Cloudflare Registrar o Namecheap |
| Respaldo en la nube | $0 | Google Drive 15 GB gratis; Backblaze B2 ~$0.30 |
| Let's Encrypt (TLS) | $0 | Automático con Caddy |
| **Total infraestructura** | **~$7/mes** | **~$84/año** |

Compáralo con cualquier sistema comercial de papelerías: $100–400 USD/mes. **En 2 meses ya amortizaste el año entero.**

Costos únicos de arranque:

| Concepto | Costo |
|----------|:---:|
| UPS + lector HID + impresora de tickets + hojas de etiquetas | ~$130 USD |
| Dominio (primer año) | ~$10 USD |
| Tu tiempo | La variable real (ver [10](10-roadmap.md)) |

## 7. Actualizaciones y operación

```powershell
# scripts/deploy.ps1 — desplegar el VPS (o hazlo a mano, no hace falta más)
# 1. Tests y migraciones en CI (obligatorio)
pnpm -r test
pnpm --filter @papeleria/db migrate:check      # las migraciones corren en PGlite Y en Postgres

# 2. Build de la PWA
pnpm --filter web build

# 3. Subir
scp -r apps/web/dist/* usuario@vps:/srv/web/
ssh usuario@vps "cd /opt/papeleria && docker compose up -d --build api"

# 4. Verificar
curl -f https://papeleria.midominio.com/api/health || echo "⚠️ No responde"
```

**Estrategia de actualización sin romper la caja:**

1. **La PWA se actualiza sola** (service worker) y funciona offline durante el deploy. El PC de la caja **no se queda sin servicio** durante un despliegue.
2. **Las migraciones de base de datos deben ser compatibles hacia atrás por una versión.** Regla: en el deploy N, puedes añadir columnas y tablas; para **renombrar o borrar**, hazlo en el deploy N+1, después de que todos los dispositivos estén actualizados. Un dispositivo con la PWA vieja y el servidor nuevo **debe seguir funcionando**.
3. **`schema_version` en cada evento** ([02](02-modelo-de-datos.md#10-sincronización-y-auditoría)) permite al servidor entender eventos de clientes viejos.

**Monitoreo mínimo (no necesitas Datadog):**

| Qué | Cómo | Frecuencia |
|-----|------|-----------|
| ¿El servidor está vivo? | `curl /api/health` desde un cron en el PC o un servicio como UptimeRobot (gratis) | Cada 5 min |
| ¿El respaldo funcionó? | El script notifica y avisa si falla | Diario |
| ¿Quedó disco? | `df -h` en el script de respaldo | Diario |
| ¿El certificado vence? | Caddy lo renueva solo; aun así, monitoriza | Semanal |
| ¿Hay eventos rechazados? | Consulta desde el script nocturno → notifica al dueño | Diario |
| ¿Cuántos dispositivos pendientes de sync? | `SELECT * FROM sync_cursors WHERE last_push_at < now() - interval '1 day'` | Diario |

## 8. Comprar vs construir: la decisión, una vez más, con datos

| Criterio | Odoo Community | Sistema comercial local | A medida (este proyecto) |
|----------|:---:|:---:|:---:|
| Código interno propio (EAN-13 prefijo 2) | ⚠️ Módulo custom en Python | Depende del proveedor: **pregúntalo** | ✅ Nativo |
| Escanear con el celular dentro de la app | ❌ Requiere desarrollo | ❌ Raro | ✅ Nativo |
| Funciona sin internet | ⚠️ Parcial (POS offline de Odoo es limitado) | ⚠️ Varía | ✅ Diseñado para eso |
| Etiquetas con precio y reimpresión selectiva | ⚠️ Básico | Varía | ✅ Con reporte de desactualizadas |
| Ledger de inventario auditable | ✅ Sí | ✅ Suele tener | ✅ Sí |
| Arqueo de caja con turnos | ✅ Sí | ✅ Sí | ✅ Sí |
| Costo mensual | $6 (VPS) | $100–400 | $7 |
| Costo de tu tiempo | Medio (Python + XML) | Bajo | **Alto** |
| Soporte cuando falla a las 8 pm | Ninguno | Teléfono (a veces) | Ninguno |
| ¿Puedes cambiar algo tú mismo? | Con esfuerzo | No | ✅ Todo |
| Riesgo de quedarte atrapado | Bajo (open source) | **Alto** (formato propietario) | Nulo (tu código, tu BD) |
| Mantenimiento a 5 años | Actualizaciones de Odoo (pueden romper módulos) | El proveedor cierra o te sube el precio | Tus migraciones (controladas) |

**Cómo decidir en 10 minutos:**

1. Pregunta a un sistema comercial: *"¿puedo generar mi propio código de barras EAN-13 con prefijo 2 y escanearlo con mi celular dentro de la app?"* Si la respuesta es "no" o "hay que desarrollarlo", y esas cosas son importantes para ti → construir.
2. Pregúntate: *"¿tengo 4–6 semanas de trabajo de una persona a medio tiempo, repartidas en 3 meses?"* Si no → comprar.
3. Pregúntate: *"¿vale $84 al año + mi tiempo tener un sistema que hace exactamente lo que quiero, para siempre?"* Si sí → construir.

**Mi recomendación con lo que sé:** construir. La combinación "código propio + celular como escáner + offline obligatorio" es exactamente el tipo de requisito que los sistemas genéricos no cubren, y con la arquitectura de estos documentos el trabajo está muy acotado. Pero hazlo **en fases** ([10](10-roadmap.md)) y **no dejes de usar Excel** hasta que el sistema pueda vender, generar código y cuadrar el stock (fases 1–3).

## 9. Checklist de despliegue

**Servidor**
- [ ] VPS con 1–2 vCPU / 1–2 GB / 20 GB
- [ ] Dominio con 2FA en el registrador
- [ ] Caddy con HTTPS automático y volumen `caddy_data` (si no, te quedas sin certificado)
- [ ] `docker-compose.yml` con Postgres **sin** puerto expuesto al mundo
- [ ] Cabeceras de seguridad: HSTS, CSP (con `wasm-unsafe-eval`), `X-Frame-Options`
- [ ] `/api/health` monitorizado cada 5 min

**Base de datos**
- [ ] **Exactamente** las mismas migraciones que en PGlite, verificadas en CI
- [ ] Migraciones compatibles hacia atrás por una versión
- [ ] `schema_version` en los eventos

**LAN y celular**
- [ ] **VÍA A** (dominio por el VPS) funcionando
- [ ] **VÍA B**: certificado mkcert con **la IP de la LAN en el SAN**
- [ ] CA instalada y **confiada** en el celular (dos pasos en iOS)
- [ ] Validado que la cámara abre en el celular por HTTPS (prueba obligatoria antes de seguir)

**Local**
- [ ] **UPS** instalado (protege la venta en curso y la BD)
- [ ] **BitLocker** activado en el PC
- [ ] Cuenta de Windows del POS **sin privilegios de admin**
- [ ] Bloqueo de pantalla del SO a los 5 min, además del bloqueo de la app
- [ ] Tarea programada del respaldo nocturno con notificación
- [ ] **Prueba de restauración** hecha al menos una vez antes de usar el sistema en producción

**Proceso**
- [ ] Verificación de disco, backup y eventos rechazados en el script diario
- [ ] Alarma mensual en el calendario para la prueba de restauración
- [ ] `.env` con permisos restringidos y **fuera** del repositorio
