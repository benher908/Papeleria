# Probador de cámara y códigos de barras

Herramienta de diagnóstico para la **tarea 0.9** de `docs/10-roadmap.md`: comprobar
que el celular puede leer códigos de barras sobre HTTPS con certificado válido,
**antes** de escribir la aplicación.

Es el único riesgo del proyecto que puede invalidar el requisito principal. Media
hora aquí ahorra semanas allá adelante.

---

## Por qué existe esto y no lo haces a mano

La cámara del navegador (`getUserMedia`) exige un **contexto seguro**: HTTPS con
certificado válido. Un certificado autofirmado no sirve; instalar la página como
aplicación (PWA) **tampoco** lo evita — es el error más común y hace perder tardes
enteras.

Preparar eso a mano son ocho pasos (mkcert, la IP en el certificado, instalarlo en
el celular, confiarlo…) y cuando algo falla no sabes **qué** de todo eso falló.
Esta herramienta convierte los ocho pasos en dos comandos, y cuando algo falla te
dice cuál de las cuatro capas se rompió:

```text
red  →  certificado  →  permiso  →  decodificador
```

Esa separación es el valor real: son cuatro problemas distintos que se manifiestan
con la misma queja («no lee»).

---

## Los dos comandos

```powershell
pnpm certificado     # una vez. Crea la autoridad certificadora y el certificado
                     # con la IP actual de tu red. Pide permiso de administrador.
pnpm camara          # levanta los servidores y te dice qué abrir en el celular
```

`pnpm certificado` pide mkcert. Si no lo tienes, el propio script te dice cómo
instalarlo (`winget install FiloSottile.mkcert`).

Y si acabas de instalarlo y tu terminal todavía tiene el PATH viejo —lo normal,
porque las terminales abiertas no se enteran de las variables de entorno nuevas—
el script lo busca igual en las carpetas donde lo dejan winget, choco y scoop. No
deberías tener que reiniciar la terminal para esto.

`pnpm camara` imprime una tabla así:

```text
  PRUEBA DE CÁMARA Y CÓDIGOS DE BARRAS
  ────────────────────────────────────────────────────
  Certificado     CN=localhost · vence 18/10/2028
  Cubre la IP     sí, incluye 192.168.1.50
  Red             Wi-Fi · 192.168.1.50

  1) En esta computadora (para ver el QR y los códigos de prueba)
     https://localhost:8443

  2) En el celular, en este orden
     http://192.168.1.50:8080   ← abre esto primero: instala el certificado
     https://192.168.1.50:8443  ← después: la prueba de la cámara
```

También registra cada visita. **Si el celular no aparece en el registro, es la red,
no el certificado** — y eso te ahorra la mitad de los diagnósticos equivocados.

---

## La prueba, paso a paso

1. **En la computadora**, corre `pnpm camara` y abre `https://localhost:8443`.
2. **En el celular**, abre `http://IP:8080` (la que imprime el script).
   → Si esto **no** abre, el problema es la red o el firewall de Windows. No sigas.
3. En esa página, toca **Descargar el certificado** e instálalo.
   - **Android:** Ajustes → Seguridad → Cifrado y credenciales → Instalar un certificado → Certificado de CA.
   - **iPhone:** además de instalarlo, hay que **activarlo** en Ajustes → General →
     Información → **Ajustes de confianza de certificados**. Si te saltas ese paso,
     Safari seguirá bloqueando la cámara.
4. Toca **Ir a la prueba de la cámara** (`https://IP:8443`).
   - Sin advertencia de seguridad = el certificado quedó bien.
5. Revisa la sección **1. Diagnóstico**: debe decir *contexto seguro: sí*.
6. La sección **4. Códigos de prueba** se autoverifica: dice «✓ leído» si el
   decodificador del celular sirve, **aunque la cámara todavía no**. Eso separa
   «el decodificador no sirve» de «la cámara no enfoca».
7. Pulsa **Encender cámara**, acepta el permiso y apunta a la pantalla de la
   computadora (a los códigos de la sección 4) o a cualquier producto del
   supermercado.

Si el paso 7 funciona, **el riesgo principal del proyecto está resuelto** y se
puede empezar a construir la aplicación.

---

## Qué comprueba cada sección

| Sección | Qué responde |
|---|---|
| 1. Diagnóstico | Contexto seguro, permiso, cámaras, certificado, y si esta copia de los códigos de barras coincide con `packages/core` |
| 2. QR | Pasa la dirección al celular sin teclearla. Apunta al servidor `http` a propósito: ese siempre abre |
| 3. Cámara y lectura | La prueba real. Con `BarcodeDetector` nativo o con ZXing-WASM de respaldo |
| 4. Códigos de prueba | Dibuja los códigos y **los lee solo**: prueba el decodificador sin cámara |

### Los dos decodificadores

- **`BarcodeDetector`** (nativo): rápido, sin descargas. Lo trae Chrome y Edge en
  Android. Es el camino normal en el mostrador.
- **ZXing-WASM** (respaldo): se baja de internet (~1 MB, una vez). Es el que hace
  funcionar iPhone, que **no** trae `BarcodeDetector`.

Los nombres de formato son distintos en cada API (`ean_13` contra `EAN-13`) y el
código los traduce en una sola tabla. Cambiar uno sin el otro es un fallo silencioso.

---

## Si algo falla

| Síntoma | Qué es | Qué hacer |
|---|---|---|
| El celular no abre `http://IP:8080` | Red o firewall | Misma wifi (no la de invitados), permitir Node en el firewall de Windows |
| Advertencia de seguridad al abrir `https://` | El certificado no incluye **esa** IP | Vuelve a correr `pnpm certificado` (la IP cambia al reiniciar el módem) |
| «Contexto NO seguro» aunque el certificado esté instalado | En iPhone falta activarlo; o entraste por `http://` | Revisa los ajustes de confianza de certificados |
| El permiso se queda cargando | Otra app tiene la cámara | Cierra otras apps; reinicia el navegador |
| Diagnóstico en verde pero «no encuentra nada» al leer imágenes | Falló el CDN o el `.wasm` | Revisa internet; abre la consola del navegador |
| La cámara se ve pero no lee | Enfoque, luz o distancia | Apoya el celular, evita reflejos, activa «modo insistente» |
| En la PC no hay cámara | Normal | La PC sirve para el QR y los códigos; la cámara se prueba en el celular |

### Errores de consola que verás y significan algo

- `Cannot read properties of undefined (reading 'detect')` → el permiso se negó.
- `TypeError: Failed to fetch` al leer imágenes → no se pudo bajar el `.wasm` de
  ZXing (sin internet, o la red bloquea jsDelivr).
- `NotAllowedError` → permiso de cámara denegado para ese sitio.

---

## Detalles de implementación que importan

- **Cero dependencias de npm.** El servidor usa solo `node:https`, `node:http`,
  `node:crypto` y `node:os`. Nada que instalar ni que se rompa.
- **Encuentra mkcert aunque el PATH esté viejo** (`mkcert.mjs`). `winget`, choco y
  scoop actualizan el PATH, pero **las terminales ya abiertas no se enteran**. El
  síntoma es desconcertante: instalas mkcert, el instalador dice que todo bien, y
  el comando sigue diciendo que no lo encuentra. Aquí se busca también en las rutas
  donde de verdad lo dejan los instaladores, así que no hace falta reiniciar nada.
  Se busca en un solo sitio para que los dos scripts compartan la respuesta.
- **Dos servidores, a propósito.** El `http` en 8080 es el que separa «red» de
  «certificado» (ver arriba). También sirve la CA, así que el celular la descarga
  sin cables ni correo.
- **El certificado se inspecciona de verdad.** El servidor lee el `.pem` con
  `X509Certificate`, saca los nombres alternativos (`subjectAltName`) y avisa si
  **no** incluye la IP actual. Ese es el fallo más frecuente y el más confuso.
- **Los CDN están verificados**, no adivinados: `bwip-js@4` expone `bwipjs.toCanvas`
  (bcids `ean13`, `code128`, `qrcode`) y `zxing-wasm@3` expone
  `ZXingWASM.readBarcodes`, con el `.wasm` servido desde jsDelivr. Ambos se
  comprobaron contra el CDN antes de escribir la página.
- **Los códigos se autoverifican.** La página duplica el cálculo del dígito
  verificador de `packages/core` (no se puede importar TypeScript sin empaquetar)
  y comprueba los mismos cuatro valores conocidos que las pruebas del núcleo. Si
  las dos copias se separan, la sección 1 lo dice en la cara.
- **`requestVideoFrameCallback`** en lugar de un `setInterval`: no analiza el mismo
  cuadro dos veces ni calienta el celular.
- **Reintento en la banda central** para códigos 1D, que es como funcionan los
  lectores de verdad.

---

## Qué NO es esto

No es parte de la aplicación. Es andamio de diagnóstico: la aplicación de verdad
(F1 en adelante) usará el mismo `BarcodeDetector`/ZXing, pero con el lector
integrado en la pantalla de venta, la cola unificada de escaneo
(`hid` | `phone` | `manual`) y el emparejamiento por QR que describe
`docs/04-escaneo-movil.md`.

Cuando el sistema esté funcionando, esta carpeta se puede borrar sin consecuencias.
