# Sincronización Shopify ↔ QuickBooks Desktop

Este proyecto expone un servicio Node.js que actúa como *stub* del QuickBooks Web Connector (QBWC) para sincronizar inventario y ventas entre Shopify y QuickBooks Desktop (QBD). El servicio recibe webhooks de Shopify, encola trabajos y responde solicitudes SOAP del Web Connector para aplicar cambios en QBD. También ofrece utilidades HTTP para empujar inventario de QBD hacia Shopify.

> **Despliegue:** la aplicación está pensada para ejecutarse en **Azure App Service (Linux)** con Node.js ≥ 18. El proceso de inicio estándar es `npm start` y el servicio escucha en el puerto que expone App Service (por defecto 8080).

## Arquitectura resumida
- **Express + SOAP manual:** `src/index.js` crea una API REST y maneja manualmente el endpoint SOAP `POST /qbwc` usando el WSDL de QuickBooks (`src/wsdl/qbwc.wsdl`).【F:src/index.js†L29-L206】【F:src/index.js†L323-L455】 
- **Cola persistente de trabajos:** los trabajos se guardan como JSON en `LOG_DIR` (por defecto `/tmp`) y se protegen con un *lock* para evitar carreras entre procesos.【F:src/services/jobQueue.js†L6-L154】 
- **Clientes Shopify:** `src/services/shopify.client.js` encapsula las llamadas REST y GraphQL de Shopify, respetando límites de velocidad configurables.【F:src/services/shopify.client.js†L1-L142】 
- **Sincronización QBD→Shopify:** `src/services/shopify.sync.js` lee el último snapshot de inventario generado por el Web Connector, calcula diferencias y actualiza niveles en Shopify.【F:src/services/shopify.sync.js†L1-L205】【F:src/services/shopify.sync.js†L441-L509】 

## Configuración en Azure App Service
1. Crea un App Service Linux con un plan que soporte Node.js ≥ 18.
2. Sube el código (por Git, ZIP Deploy o GitHub Actions) y define `npm install` como comando de construcción si usas *build automation*.
3. Establece el comando de inicio en `npm start` (o deja el valor por defecto si App Service detecta `package.json`).
4. Configura las **variables de entorno** descritas abajo en el apartado *Configuración de entorno* desde el blade **Configuration → Application settings**.
5. Habilita registros si quieres inspeccionar archivos bajo `LOG_DIR` (por ejemplo, usando Azure Storage o App Service Log Stream).
6. Una vez desplegado, verifica que `https://<tu-app>.azurewebsites.net/healthz` responde `{"ok":true}`.

## Configuración de entorno
Las variables mínimas para un entorno productivo son:

| Variable | Obligatoria | Descripción / valores recomendados |
|----------|-------------|-------------------------------------|
| `WC_USERNAME` | Sí | Usuario que usará el Web Connector para autenticarse.【F:src/services/qbwcService.js†L24-L69】 |
| `WC_PASSWORD` | Sí | Contraseña asociada al usuario del Web Connector.【F:src/services/qbwcService.js†L24-L69】 |
| `SHOPIFY_STORE` | Sí | Dominio de la tienda Shopify (ej. `mitienda.myshopify.com`).【F:src/services/shopify.client.js†L1-L74】 |
| `SHOPIFY_TOKEN` | Sí | Token Admin API con permisos de inventario y pedidos.【F:src/services/shopify.client.js†L1-L74】 |
| `SHOPIFY_LOCATION_ID` | Sí | ID numérico de la ubicación de inventario a ajustar.【F:src/services/shopify.client.js†L1-L142】 |
| `SHOPIFY_WEBHOOK_SECRET` | Recomendado | Secreto para validar webhooks de Shopify; si se omite, en desarrollo no se bloquean firmas inválidas.【F:src/routes/shopify.webhooks.js†L29-L47】 |
| `LOG_DIR` | Recomendado | Directorio persistente para la cola y snapshots. En App Service usa `/home/logs/qbd` para conservar archivos entre reinicios.【F:src/services/jobQueue.js†L6-L144】 |
| `BASE_PATH` | Opcional | Ruta base del endpoint SOAP (por defecto `/qbwc`).【F:src/index.js†L29-L205】 |
| `PORT` | Opcional | Puerto de escucha. App Service inyecta `PORT` y la app usa `8080` como respaldo.【F:src/index.js†L29-L38】 |
| `QBXML_VER` | Opcional | Versión de QBXML a usar (por defecto `16.0` en la mayoría de builders).【F:src/index.js†L152-L179】 |
| `QBD_SKU_FIELDS` | Opcional | Campos, separados por coma, que se usarán para mapear SKU entre QBD y Shopify (`Name,FullName,...`).【F:src/index.js†L32-L37】【F:src/routes/shopify.webhooks.js†L24-L47】 |
| `HAS_ADV_INV` | Opcional | `1` si tu QBD tiene Advanced Inventory y quieres consultar niveles por sitio.【F:src/services/qbwcService.js†L20-L49】 |
| `QB_MAX` | Opcional | Máximo de ítems a solicitar en cada corrida del Web Connector (por defecto `200`).【F:src/services/qbwcService.js†L20-L49】 |
| `AUTO_SEED_ON_AUTH` | Opcional | Si es `true`, encola automáticamente un `inventoryQuery` tras autenticar el Web Connector.【F:src/index.js†L395-L445】 |
| `AUTO_ENQUEUE_INVENTORY_QUERY` | Opcional | Fuerza un `inventoryQuery` en cada autenticación del Web Connector.【F:src/index.js†L395-L445】 |
| `SHOPIFY_AUTO_PUSH` | Opcional | Activa el envío automático de inventario hacia Shopify cuando se detectan cambios (ver implementación en `src/index.js`).【F:src/index.js†L200-L208】 |
| `SHOPIFY_REST_*` / `SHOPIFY_GQL_*` | Opcional | Ajustes finos de *rate limiting* y reintentos para la API de Shopify.【F:src/services/shopify.client.js†L16-L74】【F:src/services/shopify.sync.js†L13-L74】 |
| `INITIAL_SWEEP_ENABLED` / `SHOPIFY_INITIAL_SWEEP` | Opcional | Habilita la corrida inicial de conciliación (`/sync/initial/*`).【F:src/services/shopify.sync.js†L254-L274】【F:src/routes/sync.qbd-to-shopify.js†L25-L63】 |
| `QBD_SHOPIFY_*` | Opcional | Configura ítems y cuentas especiales (cliente Shopify, artículos de envío/descuento, impuestos) usados al generar ventas en QBD.【F:src/routes/shopify.webhooks.js†L59-L121】【F:src/routes/shopify.webhooks.js†L296-L324】 |

> Consejo: en App Service los archivos bajo `/home` persisten entre despliegues. Define `LOG_DIR=/home/qbd-sync` para conservar `jobs.json`, snapshots y archivos de depuración.

## Configuración del Web Connector (WC)
1. En QuickBooks Web Connector agrega una nueva aplicación usando un archivo `.qwc`. Puedes generar uno manualmente con el siguiente formato (ajusta valores entre `<>`):
   ```xml
   <?xml version="1.0"?>
   <QBWCXML>
     <AppName>Shopify QBD Sync</AppName>
     <AppURL>https://<tu-app>.azurewebsites.net/qbwc?wsdl</AppURL>
     <AppDescription>Sincronización Shopify ↔ QBD</AppDescription>
     <AppSupport>mailto:tu-correo@empresa.com</AppSupport>
     <UserName>${WC_USERNAME}</UserName>
     <OwnerID>{90A44FB7-33D9-4815-AC85-61BC3C497DC0}</OwnerID>
     <FileID>{57F3B9B6-86F1-4FCC-B1FF-967DE1813D20}</FileID>
     <QBType>QBFS</QBType>
   </QBWCXML>
   ```
2. Importa el `.qwc` en el Web Connector, ingresa la contraseña `WC_PASSWORD` cuando la solicite y marca la casilla para habilitar la app.
3. Si deseas que QuickBooks abra un archivo específico en cada sesión, define la ruta absoluta en `WC_COMPANY_FILE`. Si dejas ese valor vacío, el Web Connector usará el archivo de compañía que ya esté abierto.【F:src/index.js†L423-L451】
4. Ajusta el intervalo de ejecución automática según la frecuencia deseada (por ejemplo, cada 15 minutos).

## Endpoints útiles de depuración
- `GET /healthz` — Comprobación rápida del servicio.【F:src/index.js†L339-L343】
- `GET /debug/config` — Muestra valores efectivos (sin contraseñas) y directorio de logs.【F:src/index.js†L333-L342】
- `GET /debug/queue` — Revisa los trabajos pendientes en la cola.【F:src/index.js†L360-L372】
- `GET /debug/inventory` — Devuelve el último snapshot procesado desde QBD.【F:src/index.js†L373-L380】
- `GET /debug/last-request-qbxml.xml` y `GET /debug/last-response.xml` — Últimos mensajes QBXML enviados/recibidos.【F:src/index.js†L382-L455】

## Flujos de prueba recomendados
Antes de probar, asegúrate de:
- Tener variables de entorno configuradas y un `LOG_DIR` con permisos de escritura.
- Haber ejecutado al menos una vez el Web Connector para generar `last-inventory.json` en el directorio de logs.
- Contar con productos en Shopify cuyo SKU coincida con los campos priorizados en QBD (`QBD_SKU_FIELDS`).

### 1. Shopify → QBD (pedido a recibo de ventas)
1. **Simula o recibe un webhook de Shopify**. Puedes generar un pedido pagado en la tienda o enviar un `POST` a `https://<tu-app>.azurewebsites.net/shopify/webhooks/orders/paid` con un payload de prueba. Incluye el encabezado `X-Shopify-Topic: orders/paid` y, si tienes `SHOPIFY_WEBHOOK_SECRET`, calcula el HMAC en `X-Shopify-Hmac-Sha256`.【F:src/routes/shopify.webhooks.js†L24-L47】【F:src/routes/shopify.webhooks.js†L205-L289】
2. **Verifica la cola**: consulta `GET /debug/queue` para confirmar que existe un job `salesReceiptAdd` (o `invoiceAdd`/`creditMemoAdd` según el evento).【F:src/routes/shopify.webhooks.js†L205-L289】【F:src/index.js†L360-L455】
3. **Ejecuta el Web Connector**: inicia la sincronización manualmente o espera al intervalo automático. El método `sendRequestXML` recuperará el trabajo, lo transformará en QBXML y QuickBooks lo aplicará.【F:src/index.js†L404-L455】
4. **Confirma en QuickBooks** que el recibo/invoice se haya creado y revisa `GET /debug/last-request-qbxml.xml` para auditar el XML generado.

### 2. QBD → Shopify (ajuste de inventario)
1. **Genera un snapshot actualizado**: ejecuta el Web Connector para que `receiveResponseXML` almacene `last-inventory.json` con los niveles actuales.【F:src/services/qbwcService.js†L50-L173】
2. **Revisa el plan de sincronización**: llama a `GET /sync/qbd-to-shopify/dry-run?limit=50` para ver qué SKUs se modificarían en Shopify sin aplicar cambios.【F:src/routes/sync.qbd-to-shopify.js†L1-L43】【F:src/services/shopify.sync.js†L441-L509】
3. **Aplica los cambios**: cuando estés conforme, ejecuta `POST /sync/qbd-to-shopify/apply?limit=50` (ajusta el límite según tus necesidades). Esto actualizará los niveles disponibles en la ubicación configurada (`SHOPIFY_LOCATION_ID`).【F:src/routes/sync.qbd-to-shopify.js†L17-L43】【F:src/services/shopify.sync.js†L441-L509】
4. **Verifica en Shopify** que los productos reflejen la nueva disponibilidad. El archivo `shopify-last-pushed.json` en `LOG_DIR` detalla la última sincronización.【F:src/services/shopify.sync.js†L35-L74】【F:src/services/shopify.sync.js†L441-L509】

### Barrido inicial (opcional)
Si activas `INITIAL_SWEEP_ENABLED` (o `SHOPIFY_INITIAL_SWEEP`), puedes reconciliar diferencias iniciales entre QBD y Shopify:
1. Ejecuta `POST /sync/initial/run` para generar los conjuntos `initial-sweep-*.json` en `LOG_DIR`.
2. Usa `GET /sync/initial/unmatched/qbd` y `/sync/initial/unmatched/shopify` para identificar ítems sin correspondencia en cada sistema.【F:src/routes/sync.qbd-to-shopify.js†L45-L76】【F:src/services/shopify.sync.js†L254-L337】

## Buenas prácticas
- Mantén una copia persistente de `jobs.json` y `last-inventory.json` para auditar incidencias.
- Asegura la aplicación detrás de HTTPS y restringe el acceso a `/debug/*` mediante IP filtering o autenticación adicional en App Service.
- Rota periódicamente `WC_PASSWORD` y el token de Shopify.

Con esta guía deberías poder desplegar, configurar y validar la sincronización de extremo a extremo incluso si no tienes experiencia previa con QuickBooks Web Connector.
