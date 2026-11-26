# Sincronización QuickBooks Desktop ↔ Shopify

Servicio Node.js (Azure App Service) que conecta **QuickBooks Desktop (QBD)** con **Shopify** a través del **QuickBooks Web Connector (WC)**.

- **Pedidos de Shopify → facturas en QBD.** Cada pedido pagado se convierte en una factura en QuickBooks.
- **Inventario de QBD → Shopify.** Las cantidades de QBD se copian a Shopify. **QBD es la fuente de verdad**: es el punto de venta y la bodega.

> Si algo no funciona, ve primero a [Runbooks](#runbooks-qué-hacer-cuando) y a [Preguntas frecuentes](#preguntas-frecuentes). La mayoría de los problemas se resuelven con los endpoints de diagnóstico, sin tocar el código.

---

## Contenido

1. [Reglas de oro](#reglas-de-oro)
2. [Cómo funciona](#cómo-funciona)
3. [Requisitos en QuickBooks](#requisitos-en-quickbooks)
4. [Instalación y configuración](#instalación-y-configuración)
5. [Variables de entorno](#variables-de-entorno)
6. [Endpoints](#endpoints)
7. [Rutina de operación](#rutina-de-operación)
8. [Runbooks: qué hacer cuando…](#runbooks-qué-hacer-cuando)
9. [Preguntas frecuentes](#preguntas-frecuentes)
10. [Archivos que guarda el servicio](#archivos-que-guarda-el-servicio)
11. [Desarrollo y pruebas](#desarrollo-y-pruebas)

En los ejemplos, `$BASE` es la URL del App Service, por ejemplo `https://<tu-app>.azurewebsites.net`.

---

## Reglas de oro

1. **Las cantidades se cambian en QuickBooks, nunca en Shopify.** Recepciones, ajustes y conteos se hacen en QBD. Lo que se cambie a mano en Shopify se sobrescribe en la siguiente reconciliación.
2. **El SKU de Shopify debe ser igual al `Name` del ítem en QBD** (o al campo que diga `QBD_SKU_FIELDS`). Si no coinciden, ese producto no se sincroniza y sus facturas fallan.
3. **El Web Connector debe estar en Auto-Run.** Sin él no se crean facturas ni se actualiza Shopify.
4. **Antes de desplegar, pausa el Web Connector**: desmarca Auto-Run y espera a que termine el ciclo en curso.
5. **Revisa `GET /debug/failed-jobs` con regularidad**, o configura el correo de alertas. Una factura rechazada por QB deja el stock de QBD más alto de lo real, y ese error llega a Shopify.

---

## Cómo funciona

```
 Shopify                         Servicio (Azure)                       QuickBooks Desktop
 ───────                         ────────────────                       ──────────────────
 pedido pagado ──webhook──▶  /shopify/webhooks/orders/paid
                               └─ encola "invoiceAdd" en la cola
                                                                   ◀── Web Connector (cada N min)
                               /qbwc  authenticate                        │
                                 └─ encola 1 "inventoryQuery" (si no hay otro pendiente)
                               /qbwc  sendRequestXML  ──── factura ────▶  crea la factura
                               /qbwc  receiveResponseXML ◀── respuesta ── (si QB la rechaza → failed-jobs + correo)
                               /qbwc  sendRequestXML  ── inventoryQuery ▶ devuelve catálogo + cantidades
                               /qbwc  receiveResponseXML ◀── catálogo ───
                                 ├─ guarda last-inventory.json
                                 ├─ envía a Shopify lo que cambió en QBD (sync por diferencia)
                                 └─ si toca, reconciliación completa (QBD manda)
 cantidades  ◀──────── API Admin ──┘
```

### Los tres mecanismos de inventario QBD → Shopify

| Mecanismo | Cuándo corre | Qué hace |
|---|---|---|
| **Sync por diferencia** | En cada poll del WC (si `SHOPIFY_AUTO_PUSH` no es `false`) | Envía a Shopify solo los ítems cuya cantidad en QBD cambió desde el último envío. Máximo `SYNC_MAX_PER_RUN` (500) por ciclo. Los cambios reales van antes que los reintentos. |
| **Reconciliación completa** | Automática a la hora fijada (`SHOPIFY_RECONCILE_AT`) o cada `SHOPIFY_RECONCILE_INTERVAL_MS`; o manual con `POST /sync/reconcile` | Lee las cantidades **reales** de Shopify y corrige cualquier diferencia contra QBD. Atrapa todo lo que el sync por diferencia no ve (ediciones manuales en Shopify, sobreventas, apps externas). |
| **Dry-run** | Manual: `POST /sync/reconcile?dryRun=1` | Muestra qué cambiaría sin cambiar nada. **Úsalo siempre antes de una reconciliación manual.** |

### Qué NO hace el servicio

- **No pasa reembolsos ni cancelaciones a QBD.** El código de notas crédito existe pero el webhook está desactivado. Se hacen a mano en QB.
- **No crea productos** en QBD ni en Shopify. Hay que crearlos en los dos con el mismo SKU.
- **No pasa ajustes de inventario de Shopify a QBD**, salvo que actives `SHOPIFY_INV_LEVEL_TO_QBD`. No lo actives si QBD es la fuente de verdad.
- **No factura pedidos sin pagar.** Solo escucha `orders/paid`; un pedido pagado después se factura cuando se paga.

---

## Requisitos en QuickBooks

Las facturas que crea el servicio usan estos elementos. **Si alguno no existe con el nombre exacto, QB rechaza la factura**, que aparecerá en `GET /debug/failed-jobs`.

| Elemento | Nombre esperado | Configurable con |
|---|---|---|
| Cliente para ventas en línea | `ONLINE SALES` | `QBD_SHOPIFY_CUSTOMER` (o `_FULLNAME` / `_LISTID`) |
| Ítem de envío | `SHIPPING WITH GUARANTEE` | fijo en el código |
| Ítem de descuento | `Discount` | `QBD_SHOPIFY_DISCOUNT_ITEM` (o `_FULLNAME` / `_LISTID`) |
| Códigos de impuesto | `TAX` y `NON` | fijos en el código |
| Ítem de impuesto de la compañía | (opcional) | `QBD_COMPANY_TAX_NAME` |
| Cuenta para ajustes de inventario | `Inventory Adjustment` | `QBD_ADJUST_ACCOUNT` (solo si usas `SHOPIFY_INV_LEVEL_TO_QBD`) |

Cada producto de un pedido se busca en el último catálogo de QBD por SKU. Si no se encuentra, la línea se envía con el SKU como nombre del ítem y QB la rechaza.

---

## Instalación y configuración

### 1. Azure App Service

- App Service Linux con Node.js ≥ 18. Comando de inicio: `npm start`.
- **`LOG_DIR` debe estar bajo `/home`**, por ejemplo `/home/logs/qbd`. Ahí viven la cola, el estado y los registros. `/tmp` se borra al reiniciar y **se perderían los pedidos pendientes**.
- `DEBUG_DIR` en otro directorio, por ejemplo `/home/logs/qbd-debug`, para que los volcados XML no llenen el disco.
- Despliegue: cada push a `main` despliega a **staging**. **Producción** requiere aprobar el job `deploy_production` en GitHub Actions.
- Comprobación: `GET $BASE/healthz` → `{"ok":true}`.

### 2. QuickBooks Web Connector

Archivo `.qwc` (ajusta los valores entre `< >`):

```xml
<?xml version="1.0"?>
<QBWCXML>
  <AppName>Shopify QBD Sync</AppName>
  <AppURL>https://<tu-app>.azurewebsites.net/qbwc</AppURL>
  <AppDescription>Sincronización Shopify ↔ QBD</AppDescription>
  <AppSupport>https://<tu-app>.azurewebsites.net/healthz</AppSupport>
  <UserName>(valor de WC_USERNAME)</UserName>
  <OwnerID>{90A44FB7-33D9-4815-AC85-61BC3C497DC0}</OwnerID>
  <FileID>{57F3B9B6-86F1-4FCC-B1FF-967DE1813D20}</FileID>
  <QBType>QBFS</QBType>
</QBWCXML>
```

1. En el Web Connector: **Add an application** → selecciona el `.qwc`.
2. Escribe la contraseña (`WC_PASSWORD`) y marca **Auto-Run**, con un intervalo de 5 a 15 minutos.
3. QuickBooks debe estar abierto con la compañía, o define `WC_COMPANY_FILE` con la ruta del archivo.

Comprobación: `GET $BASE/qbwc` → `QBWC endpoint OK`, y tras el primer ciclo `GET $BASE/debug/wc-status` muestra `minutesSinceLastSeen` reciente.

### 3. Shopify

- **App personalizada** con permisos de Admin API para pedidos, productos e inventario (lectura y escritura de inventario). El token va en `SHOPIFY_TOKEN`.
- **Ubicación**: `GET $BASE/shopify/locations` lista las ubicaciones. Pon el ID de la bodega en `SHOPIFY_LOCATION_ID`.
- **Webhooks** (Configuración → Notificaciones → Webhooks, formato JSON):

| Evento | URL | ¿Necesario? |
|---|---|---|
| Pago del pedido (`orders/paid`) | `$BASE/shopify/webhooks/orders/paid` | **Sí** |
| Actualización de producto (`products/update`) | `$BASE/shopify/webhooks/products/update` | Opcional. **Ojo:** copia a QBD el precio, la descripción y el código de barras editados en Shopify. No lo registres si esos datos también deben venir de QBD. |
| Nivel de inventario (`inventory_levels/update`) | `$BASE/shopify/webhooks/inventory_levels/update` | No (no hace nada si `SHOPIFY_INV_LEVEL_TO_QBD` no es `true`). |

- Copia la clave de firma de los webhooks en `SHOPIFY_WEBHOOK_SECRET`. Sin ella, cualquiera podría enviar pedidos falsos.

### 4. Primera puesta en marcha

1. Configura las variables (ver abajo) y despliega.
2. Corre el Web Connector una vez (**Update Selected**). La primera consulta de inventario **solo registra la línea base y no envía nada a Shopify**.
3. `POST $BASE/sync/reconcile?dryRun=1` y revisa las diferencias.
4. `POST $BASE/sync/reconcile` para alinear Shopify con QBD.
5. Activa la reconciliación diaria (`SHOPIFY_RECONCILE_ENABLED`, `SHOPIFY_RECONCILE_AT`, `SHOPIFY_RECONCILE_TZ`).

---

## Variables de entorno

Se configuran en Azure → App Service → **Configuration → Application settings**. Al guardar, el App Service se reinicia.

### Obligatorias

| Variable | Descripción |
|---|---|
| `WC_USERNAME` / `WC_PASSWORD` | Credenciales que usa el Web Connector (deben coincidir con el `.qwc`). |
| `SHOPIFY_STORE` | Dominio de la tienda, p. ej. `mitienda.myshopify.com`. |
| `SHOPIFY_TOKEN` | Token de Admin API de la app personalizada. |
| `SHOPIFY_LOCATION_ID` | ID numérico de la ubicación de inventario (ver `GET /shopify/locations`). |
| `LOG_DIR` | Directorio persistente, bajo `/home`. |

### Recomendadas

| Variable | Valor sugerido | Descripción |
|---|---|---|
| `SHOPIFY_WEBHOOK_SECRET` | (de Shopify) | Valida la firma de los webhooks. |
| `DEBUG_DIR` | `/home/logs/qbd-debug` | Volcados XML de depuración, separados de `LOG_DIR`. |
| `AUTO_ENQUEUE_INVENTORY_QUERY` | `true` | Pide el catálogo de QBD en cada ciclo del WC (necesario para que Shopify se actualice). Solo se encola uno si no hay otro pendiente. |
| `SHOPIFY_RECONCILE_ENABLED` | `true` | Activa la reconciliación automática. |
| `SHOPIFY_RECONCILE_AT` | `00:30` | Hora(s) fija(s) del día: `00:30` o `00:30,13:00`. |
| `SHOPIFY_RECONCILE_TZ` | `America/Bogota` | Zona horaria IANA de `SHOPIFY_RECONCILE_AT` (por defecto `UTC`). `America/New_York` ajusta solo el horario de verano. |
| `ALERT_EMAIL_TO` + `MS_GRAPH_*` (o `SMTP_*`) | — | Correos de "Web Connector caído" y "QB rechazó una factura". Ver [alertas](#alertas-por-correo). |

### Sincronización (opcionales)

| Variable | Por defecto | Descripción |
|---|---|---|
| `SHOPIFY_AUTO_PUSH` | `true` | `false` desactiva el sync por diferencia en cada poll. |
| `SHOPIFY_RECONCILE_INTERVAL_MS` | `21600000` (6 h) | Intervalo de la reconciliación automática si no se usa `SHOPIFY_RECONCILE_AT`. |
| `SHOPIFY_RECONCILE_MAX` | `1000` | Máximo de correcciones por reconciliación. |
| `SYNC_MAX_PER_RUN` | `500` | Máximo de ítems por sync por diferencia. |
| `SYNC_UNMATCHED_RETRY_MS` | `21600000` (6 h) | Cada cuánto se reintenta buscar en Shopify un SKU que no se encontró. |
| `SYNC_ERROR_RETRY_MS` | `900000` (15 min) | Reintento de ítems que fallaron por error de API. |
| `SHOPIFY_SYNC_LOCK_STALE_MS` | `1800000` (30 min) | A partir de cuánto un bloqueo de sync se considera abandonado y se libera solo. |
| `QBD_SKU_FIELDS` | `Name` | Campo(s) de QBD que se comparan con el SKU de Shopify, en orden: `Name,FullName,BarCodeValue`. |
| `SKU_OVERRIDES_PATH` | `<LOG_DIR>/sku-overrides.json` | Mapeos manuales SKU → ítem de QBD. |
| `SHOPIFY_INV_LEVEL_TO_QBD` | `false` | `true` crea ajustes de inventario en QBD cuando sube el stock en Shopify. **No usar si QBD es la fuente de verdad.** |
| `AUTO_SEED_ON_AUTH` | — | Igual que `AUTO_ENQUEUE_INVENTORY_QUERY` (cualquiera de las dos basta). |

### QuickBooks (opcionales)

| Variable | Por defecto | Descripción |
|---|---|---|
| `WC_COMPANY_FILE` | (vacío) | Ruta del archivo `.QBW`. Vacío = usa la compañía abierta. |
| `QBXML_VER` | `16.0` (`13.0` para consultas de inventario) | Versión de QBXML. |
| `QBD_SHOPIFY_CUSTOMER` | `ONLINE SALES` | Cliente de las facturas (`_FULLNAME` / `_LISTID`). |
| `QBD_SHOPIFY_DISCOUNT_ITEM` | `Discount` | Ítem de descuento (`_FULLNAME` / `_LISTID`). |
| `QBD_COMPANY_TAX_NAME` | — | Ítem de impuesto de la compañía en la factura. |
| `QBD_ADJUST_ACCOUNT` | `Inventory Adjustment` | Cuenta de ajustes de inventario. |
| `BASE_PATH` | `/qbwc` | Ruta del endpoint SOAP. |

### Alertas por correo

| Variable | Descripción |
|---|---|
| `ALERT_EMAIL_TO` | Destinatario(s), separados por coma. |
| `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_SENDER` | **Recomendado** (Microsoft 365). App registrada en Entra con permiso de aplicación `Mail.Send` y consentimiento de administrador. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_FROM` | Alternativa SMTP, solo si el proveedor permite autenticación básica. |
| `WC_DOWN_ALERT_MINUTES` | Minutos sin polls para avisar que el WC está caído (por defecto `20`). |
| `WC_DOWN_ALERT_REPEAT_MINUTES` | Cada cuánto se repite el aviso mientras siga caído (por defecto `60`). |
| `WC_DOWN_ALERT_ENABLED` | Fuerza activar/desactivar el monitor (por defecto: activo si hay correo configurado). |

### Mantenimiento (opcionales)

| Variable | Por defecto | Descripción |
|---|---|---|
| `LAST_RESPONSE_KEEP` | `200` | Respuestas XML de QB que se conservan en `DEBUG_DIR`. |
| `LAST_RESPONSE_MAX_AGE_HOURS` | `24` | Antigüedad máxima de esas respuestas (`0` = sin límite). |
| `HEALTHZ_PING_ENABLED` | activo en Azure | Auto-ping a `/healthz` para que App Service no "duerma" la app. |
| `HEALTHZ_PING_INTERVAL_MS` | `300000` | Intervalo del auto-ping. |
| `SHOPIFY_REST_*`, `SHOPIFY_GQL_*`, `SHOPIFY_API_VERSION` | — | Límites y reintentos de la API de Shopify. No cambiarlos sin motivo. |
| `SHOPIFY_SYNC_DEBUG`, `SHOPIFY_REST_DEBUG`, `DEBUG_JOB_QUEUE`, `DEBUG_LOG_RETENTION` | — | Más detalle en los logs. |

---

## Endpoints

Todos van sobre `$BASE`. Los `GET` se pueden abrir en el navegador; los `POST` requieren Postman o `curl -X POST`.

### Salud y estado general

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/healthz` | El servicio está vivo → `{"ok":true}`. |
| GET | `/debug/wc-status` | ¿El Web Connector está haciendo polls? Mira `minutesSinceLastSeen`. |
| GET | `/debug/config` | Usuario del WC, `LOG_DIR`, `DEBUG_DIR` (sin contraseñas). |
| GET | `/debug/where` | Archivos en `LOG_DIR` y `DEBUG_DIR`, con tamaño y fecha. |

### Cola de trabajos (pedidos y consultas pendientes para QB)

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/debug/queue/summary` | **Empieza aquí.** Total de trabajos pendientes por tipo. |
| GET | `/debug/queue` | Cola completa (puede ser muy grande). |
| POST | `/debug/queue/compact?dryRun=1` | Muestra cuántas consultas de inventario repetidas se eliminarían. |
| POST | `/debug/queue/compact` | Deja **una** consulta de inventario al final y conserva facturas y notas crédito en orden. |
| GET | `/debug/seed-inventory` | Encola una consulta de inventario manual (se procesa en el siguiente ciclo del WC). |

### Facturas rechazadas o sin confirmar

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/debug/failed-jobs` | Documentos que QB rechazó (`failed`, con el mensaje de QB) o que quedaron sin confirmar porque el ciclo se cortó (`unconfirmed`). |
| POST | `/debug/failed-jobs/retry?id=<id>` | Reencola uno o varios (`?id=a,b`) después de corregir la causa. `?all=1` reencola todos. |
| POST | `/debug/failed-jobs/dismiss?id=<id>` | Quita del registro sin reencolar (p. ej. si lo creaste a mano en QB). |

### Inventario QBD → Shopify

| Método | Ruta | Para qué |
|---|---|---|
| POST | `/sync/reconcile?dryRun=1` | **Compara todo el catálogo** y muestra las diferencias (`diffs`) sin cambiar nada. |
| POST | `/sync/reconcile` | Corrige todas las diferencias en Shopify. Responde `202` y corre en segundo plano. |
| POST | `/sync/reconcile?limit=50` | Igual, pero corrige como máximo 50. |
| GET | `/sync/reconcile/status` | Resultado de la última reconciliación y horario configurado (`schedule`). |
| GET | `/debug/sync-lock` | ¿Hay un sync en curso o un bloqueo abandonado? |
| POST | `/debug/sync-lock/release` | Libera el bloqueo a mano. Normalmente no hace falta: se libera solo a los 30 min. |
| GET | `/debug/drift` | Qué SKUs de QBD existen o no en Shopify (consulta en vivo). `?cached=1` muestra la última. |
| GET | `/debug/sync-state` | Última cantidad confirmada en Shopify por ítem. |
| GET | `/debug/unmatched` | SKUs de QBD que no se encontraron en Shopify en el último sync. |
| GET | `/debug/sync-health` | Resumen del último sync por diferencia. |
| GET | `/debug/inventory?sku=<sku>` | Último catálogo de QBD (filtrable por `sku` o `name`). |
| GET | `/debug/snapshot` | Lo que usaría el sync por diferencia. |
| GET | `/shopify/locations` | Ubicaciones de Shopify (para `SHOPIFY_LOCATION_ID`). |

### Depuración avanzada

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/debug/last-response` | Última respuesta XML de QuickBooks. |
| GET | `/debug/last-post-body` | Último mensaje SOAP recibido del WC. |
| GET | `/debug/last-auth-cred` | Compara (con hash) las credenciales que envió el WC con las configuradas. Útil si el WC no autentica. |
| GET | `/debug/last-auth-request`, `/debug/last-auth-response` | Último intercambio de autenticación. |
| GET | `/sync/qbd-to-shopify/dry-run`, POST `/sync/qbd-to-shopify/apply` | Sync por diferencia manual (versión antigua; prefiere `/sync/reconcile`). |
| POST | `/debug/sync-state/reset` | ⚠️ Borra el estado del sync. La siguiente consulta solo vuelve a sembrar la línea base. Úsalo solo si el estado está corrupto, y luego corre una reconciliación. |

> **Seguridad:** los endpoints `/debug/*` y `/sync/*` no piden autenticación. Considera restringir el acceso en Azure (Networking → Access restrictions) sin bloquear `/qbwc` (lo usa el WC) ni `/shopify/webhooks/*` (lo usa Shopify).

---

## Rutina de operación

**Diaria (1 minuto):**
1. `GET /debug/wc-status`: `minutesSinceLastSeen` menor que el intervalo del WC.
2. `GET /debug/failed-jobs`: `"total": 0`. Si hay alguno, ve al [runbook de facturas rechazadas](#qb-rechazó-una-factura).
3. `GET /sync/reconcile/status`: la última corrida es de hoy (después de `SHOPIFY_RECONCILE_AT`), con `"status": "completed"` y `"failed": 0`.

**Semanal:**
- `GET /debug/queue/summary`: la cola debe estar casi vacía (como mucho 1 `inventoryQuery` y facturas recientes).
- Revisa los `unmatchedSample` con `qbdQty > 0` en la última reconciliación: si alguno está publicado en Shopify, su SKU no coincide con QBD.

---

## Runbooks: qué hacer cuando…

### El Web Connector estuvo detenido varios días / un ciclo tarda horas o da 502

Causa típica: la cola acumuló miles de consultas de inventario de versiones anteriores, o hay muchas facturas pendientes.

1. **Pausa el WC**: desmarca Auto-Run. Si hay un ciclo corriendo, ciérralo (icono en la bandeja → Exit).
2. `GET /debug/queue/summary`: anota cuántas facturas (`invoiceAdd`, `salesReceiptAdd`, `creditMemoAdd`) hay.
3. Si hay más de un `inventoryQuery`: `POST /debug/queue/compact?dryRun=1`, verifica que en `after` quede el **mismo número de facturas**, y luego `POST /debug/queue/compact`.
4. En el WC, **Update Selected**. Sigue el avance con `/debug/queue/summary` (el total baja a 0).
5. `GET /debug/failed-jobs`: resuelve lo que haya (ver siguiente runbook).
6. Compara los pedidos de Shopify del periodo con las facturas de QB (el **memo** de la factura es el número de pedido). Crea a mano las que falten.
7. Si creaste o reintentaste facturas: `GET /debug/seed-inventory` y **Update Selected** otra vez.
8. `POST /sync/reconcile?dryRun=1`, revisa, y `POST /sync/reconcile`.
9. Vuelve a marcar **Auto-Run**.

### QB rechazó una factura

1. `GET /debug/failed-jobs` → lee `error`. Los más comunes:

| Mensaje de QB (`statusCode`) | Causa | Solución |
|---|---|---|
| `3140` "invalid reference to QuickBooks Item …" | Un SKU del pedido no existe en QBD, o el ítem de envío/descuento no existe. | Crea el ítem en QBD con `Name` = SKU (o corrige el SKU en Shopify), o añade un mapeo en `sku-overrides.json`. |
| `3140` "… Customer …" | No existe el cliente `ONLINE SALES` (o el de `QBD_SHOPIFY_CUSTOMER`). | Créalo en QBD. |
| `3140` "… Sales Tax Code …" | No existen los códigos `TAX` / `NON`. | Créalos en QBD. |
| Mensaje sobre fecha de cierre / *closing date* | La fecha del pedido cae en un período cerrado de QBD. | Ajusta la fecha de cierre o crea la factura a mano. |
| Mensaje "in use" / registro bloqueado | Otro usuario de QB tiene abierto ese registro. | Reintenta más tarde. |

2. Corregida la causa: `POST /debug/failed-jobs/retry?id=<id>` y corre el WC.
3. Si prefieres crearla a mano: créala en QB y luego `POST /debug/failed-jobs/dismiss?id=<id>`.

**Si el estado es `unconfirmed`:** el ciclo se cortó con esa factura en curso (reinicio, deploy, 502). **Busca primero en QB una factura con ese número de pedido en el memo.** Si existe → `dismiss`. Si no → `retry`. Nunca hagas `retry` sin revisar, porque podrías duplicarla.

### La reconciliación (dry-run) muestra diferencias raras

- **Muchos SKUs con exactamente el mismo valor en Shopify** (todos en 5 o en 10): casi siempre son cantidades puestas a mano en Shopify. Si esas unidades existen pero no están en QBD, **ingrésalas primero en QB**; si no, la reconciliación las pone en 0.
- **Valores negativos en Shopify:** son sobreventas. La reconciliación los pone en lo que diga QBD (normalmente 0). Revisa si esos pedidos se pueden cumplir.
- **Shopify más alto que QBD en 1 a 3 unidades en muchos SKUs:** ventas registradas en QBD (punto de venta) que no se habían enviado. Es normal; aplica.
- **Una caída grande (p. ej. 388 → 0):** confirma en QBD antes de aplicar.

### `POST /sync/reconcile` responde 409 "Shopify sync already running"

Hay otro sync corriendo. `GET /debug/sync-lock`: si `"stale"` tiene valor, el bloqueo está abandonado y se libera solo en la siguiente llamada. Si lleva más de 30 min, espera o usa `POST /debug/sync-lock/release`.

### El Web Connector no autentica

`GET /debug/last-auth-cred`: `matchUser` y `matchPassHash` deben ser `true`. Si no, el usuario o la contraseña del WC no coinciden con `WC_USERNAME` / `WC_PASSWORD`.

### Desplegar sin perder nada

1. Pausa el WC (Auto-Run desmarcado, sin ciclo en curso).
2. Fusiona a `main` → se despliega a staging → aprueba `deploy_production`.
3. `GET /healthz` y `GET /debug/queue/summary` (la cola sigue ahí; vive en `LOG_DIR`).
4. Vuelve a marcar Auto-Run. Si el deploy cortó una factura en curso, aparecerá como `unconfirmed` en `/debug/failed-jobs`.

---

## Preguntas frecuentes

### Inventario

**¿Por qué cambié una cantidad en Shopify y volvió al valor anterior?**
Porque QBD es la fuente de verdad: la reconciliación pone en Shopify lo que dice QBD. Haz el cambio en QBD.

**Recibí mercancía en QBD. ¿Cuándo se refleja en Shopify?**
En el siguiente ciclo del Web Connector (según su intervalo), por el sync por diferencia. No hay que hacer nada.

**¿Por qué un producto no se actualiza nunca en Shopify?**
Su SKU en Shopify no coincide con el `Name` en QBD. Búscalo en `unmatchedSample` de `/sync/reconcile/status` o en `/debug/unmatched`. Corrige el SKU en Shopify o el nombre en QBD. No importan las mayúsculas, los espacios al inicio o al final ni los espacios dobles; sí importan los guiones, los puntos y si hay o no un espacio (`BD 400.4` ≠ `BD400.4`).

**La reconciliación dice `unmatched: 2000`. ¿Es grave?**
No necesariamente: son ítems de QBD que no están publicados en Shopify (repuestos, ítems viejos, servicios). Solo importan los que **sí** están en Shopify con otro SKU.

**¿Por qué QBD tiene cantidades negativas y Shopify muestra 0?**
Shopify no recibe cantidades negativas desde QBD: se envían como 0.

**¿Cada cuánto se compara todo el catálogo?**
A la hora de `SHOPIFY_RECONCILE_AT` (p. ej. 00:30 hora de `SHOPIFY_RECONCILE_TZ`), una vez al día. Además, en cada ciclo del WC se envían los cambios detectados en QBD. Puedes forzar una comparación con `POST /sync/reconcile?dryRun=1`.

**¿Y si el Web Connector está caído a la hora de la reconciliación?**
Se ejecuta en el primer ciclo después de que vuelva, una sola vez, con el inventario recién leído. Mientras está caído, Shopify no recibe cambios de QBD; por eso existe la alerta por correo.

**¿Puedo hacer que Shopify mande sobre QBD?**
No está pensado para eso. `SHOPIFY_INV_LEVEL_TO_QBD=true` solo pasa a QBD los **aumentos** de stock hechos en Shopify, y rompe la regla de que QBD manda.

### Pedidos y facturas

**¿Cuándo se crea la factura de un pedido?**
Cuando Shopify marca el pedido como pagado (webhook `orders/paid`). Se crea en QB en el siguiente ciclo del Web Connector.

**¿Cómo encuentro en QB la factura de un pedido?**
El **memo** de la factura es el número de pedido de Shopify (p. ej. `1646`). El cliente es `ONLINE SALES`.

**¿Se pierde una factura si el Web Connector está caído?**
No. Queda en la cola (`/debug/queue/summary`) hasta que el WC vuelva, y se procesa en orden.

**¿Y si QuickBooks la rechaza?**
Queda en `/debug/failed-jobs` con el mensaje de QB y, si hay correo configurado, te llega un aviso. El WC sigue con los demás trabajos. Ver [runbook](#qb-rechazó-una-factura).

**¿Qué pasa con los reembolsos y cancelaciones?**
No se sincronizan. Hazlos a mano en QB (nota crédito o anular la factura). Si el reembolso devuelve mercancía a bodega, regístralo en QB y el stock se actualizará en Shopify.

**¿Cómo se registra el descuento? ¿Y el envío?**
El descuento total del pedido va como línea negativa con el ítem `Discount` (y el código o nombre del descuento en la descripción). El envío va como línea `SHIPPING WITH GUARANTEE`, aunque sea gratis (0.00).

**¿Puede duplicarse una factura?**
Solo en casos raros: si Shopify reenvía el mismo webhook, o si haces `retry` de un `unconfirmed` que QB sí había creado. Revisa por memo antes de reintentar.

**Edité un producto en Shopify y cambió el precio en QB. ¿Por qué?**
Está registrado el webhook `products/update`, que copia a QBD el precio, la descripción y el código de barras. Si no lo quieres, elimina ese webhook en Shopify.

### Web Connector y servicio

**¿Cómo pauso el Web Connector?**
Desmarca **Auto-Run**. Para cortar un ciclo en curso, cierra el WC desde el icono de la bandeja (Exit).

**¿Cómo corro un ciclo manual?**
En el WC, selecciona la aplicación y pulsa **Update Selected**.

**Un ciclo tarda horas.**
Ver [runbook](#el-web-connector-estuvo-detenido-varios-días--un-ciclo-tarda-horas-o-da-502). Desde esta versión ya no se acumulan consultas de inventario repetidas.

**¿Reiniciar el App Service arregla algo?**
Casi nunca: la cola, el estado y los bloqueos viven en `LOG_DIR`, que sobrevive al reinicio. Usa los endpoints de diagnóstico.

**Postman me devuelve 504 o 502.**
Azure corta las peticiones de más de ~230 s. `POST /sync/reconcile` ya responde `202` y sigue en segundo plano: consulta `/sync/reconcile/status`. Si un ciclo del WC da 502, ver el runbook de la cola.

**¿Cómo sé que me llegarán los correos de alerta?**
`GET /debug/wc-status` → `"enabled": true`. Si es `false`, falta configurar `ALERT_EMAIL_TO` y Microsoft Graph o SMTP.

**¿Dónde veo los logs?**
Azure → App Service → **Log stream**. Busca `[sync]`, `[qbwc]`, `[failedJobs]` o `[inventory]`.

---

## Archivos que guarda el servicio

En `LOG_DIR` (persistente). Se pueden ver con `GET /debug/where` o desde Kudu (`https://<tu-app>.scm.azurewebsites.net`).

| Archivo | Contenido | ¿Se puede borrar? |
|---|---|---|
| `jobs.json` | Cola de trabajos pendientes para QB. | **No.** Contiene pedidos sin facturar. Usa `/debug/queue/compact`. |
| `current-job.json` | Trabajo enviado a QB en este momento. | No. |
| `failed-jobs.json` | Facturas rechazadas o sin confirmar. | Usa `/debug/failed-jobs/dismiss`. |
| `last-inventory.json` | Último catálogo de QBD. | Sí (se regenera en el siguiente ciclo). |
| `shopify-sync-state.json` (`.bak`) | Última cantidad confirmada en Shopify por ítem. | Solo con `/debug/sync-state/reset`. |
| `shopify-reconcile.json` | Resultado de la última reconciliación. | Sí. |
| `shopify-sync.lock` | Bloqueo de sync en curso. | Usa `/debug/sync-lock/release`. |
| `shopify-unmatched.json`, `shopify-sync-health.json`, `shopify-drift.json`, `shopify-last-pushed.json` | Diagnóstico. | Sí. |
| `wc-last-seen.json`, `wc-alert-state.json` | Monitor del Web Connector. | Sí. |
| `sku-overrides.json` | Mapeos manuales `[{ "sku": "...", "ListID": "..." }]` (o `FullName` / `Name`). | Solo si ya no los necesitas. |

En `DEBUG_DIR`: volcados XML (`last-response*.xml`, `last-request-qbxml.xml`, etc.). Se podan solos y se pueden borrar.

---

## Desarrollo y pruebas

```bash
npm install
npm test                      # pruebas unitarias (node --test)
for f in scripts/verify-*.js; do node "$f"; done   # verificaciones sin QBD ni Shopify reales
npm start                     # servidor local (PORT, por defecto 8080)
```

| Script | Verifica |
|---|---|
| `verify-sync-state.js` | Sync por diferencia, reintentos y prioridad de cambios reales. |
| `verify-reconcile.js` | Reconciliación completa con Shopify simulado. |
| `verify-reconcile-schedule.js` | Reconciliación a hora fija, zonas horarias y WC caído. |
| `verify-sync-lock.js` | Bloqueos abandonados. |
| `verify-queue-compact.js` | Deduplicación y compactación de la cola. |
| `verify-failed-jobs.js` | Detección de rechazos de QB y reintentos. |
| `verify-wc-monitor.js`, `verify-mailer-graph.js` | Alerta de Web Connector caído y envío de correo. |
| `verify-debug-dir.js` | Separación de volcados en `DEBUG_DIR`. |

Estructura principal:

```
src/index.js                     servidor, endpoint SOAP /qbwc y endpoints /debug
src/routes/shopify.webhooks.js   webhooks de Shopify (pedidos → facturas)
src/routes/sync.qbd-to-shopify.js /sync/* (reconciliación)
src/services/shopify.sync.js     sync, reconciliación, bloqueos, horario
src/services/syncState.js        estado del sync por diferencia
src/services/jobQueue.js         cola persistente
src/services/failedJobs.js       registro de facturas rechazadas
src/services/qbResponse.js       lectura de códigos de estado de QB
src/services/wcMonitor.js        alerta de Web Connector caído
src/services/qbd.*.js            constructores de QBXML (factura, recibo, nota crédito, ajustes)
```
