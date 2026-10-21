# Sincronización entre dispositivos en Render

La API conserva eventos y los clientes los aplican de forma idempotente sobre su base local.
Una instancia de la API representa una sola papelería; todos los dispositivos emparejados
con ella comparten sus eventos.

## Activación

1. En Render, abre el servicio `papeleria-api` y ve a **Environment**.
2. Añade `SYNC_PAIRING_CODE` con un valor aleatorio de al menos 32 caracteres. No lo guardes en Git ni lo compartas fuera de los dispositivos de confianza.
3. Guarda. Render reiniciará el servicio y `apps/api` aplicará la migración `0012_sync_transport.sql` al arrancar.
4. En cada navegador, cierra sesión y vuelve a entrar. Pega el mismo código en **Código para vincular otro dispositivo**.
5. La barra superior mostrará el estado de sincronización. Los clientes suben eventos pendientes y descargan cambios cada 20 segundos; al volver la conexión, reintentan.

La API pública no permite subir ni descargar eventos sin un token individual de dispositivo. El código solo se usa para emparejar; la API guarda el hash del token entregado. Rotar `SYNC_PAIRING_CODE` impide emparejar dispositivos nuevos y conserva los ya emparejados.

## Limitaciones actuales

- El emparejamiento es de confianza compartida: cualquier persona con el código puede vincular un dispositivo. Mantén el código privado.
- Los eventos de catálogo, inventario, caja y ventas son idempotentes. Categorías, proveedores y unidades nuevos también generan eventos.
- Los registros de categorías, proveedores o unidades que existían antes de esta versión no se envían automáticamente si no tienen un evento pendiente asociado. Los datos generales del negocio guardados en Ajustes tampoco se replican todavía.
- La API gratuita de Render puede dormir; el primer intento de sincronización tras inactividad puede tardar mientras despierta.
