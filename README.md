# QBWC SOAP Stub (DEV)

See README in previous steps. 😊

## Mapeo de ubicaciones de Shopify hacia sitios de QuickBooks Desktop

El webhook `inventory_levels/update` ahora adjunta la información de sitio adecuada en cada
ajuste de inventario generado. Para habilitarlo define la variable de entorno
`SHOPIFY_QBD_SITE_MAP` (o sus alias `SHOPIFY_LOCATION_SITE_MAP` /
`SHOPIFY_TO_QBD_SITE_MAP`) con un objeto JSON que relacione el `location_id` de Shopify
con el sitio correspondiente en QBD.

Cada entrada debe producir un `InventorySiteRef` y, opcionalmente, un
`InventorySiteLocationRef`. Los valores pueden declararse como nombre (FullName) o como
identificador (ListID):

```bash
export SHOPIFY_QBD_SITE_MAP='{
  "123456789": { "FullName": "Main Warehouse" },
  "987654321": { "ListID": "80000001-123456789" },
  "246813579": {
    "InventorySiteRef": { "FullName": "Secondary Warehouse" },
    "InventorySiteLocationRef": { "FullName": "Aisle 4" }
  }
}'
```

Si se especifica un simple string (por ejemplo `"123456789": "Main Warehouse"`), se
interpretará como `FullName`. Los objetos permiten usar claves alternativas como
`site`, `inventorySite`, `location` o `siteLocation` para mayor flexibilidad.

## Validación del flujo con QuickBooks Web Connector

1. Lanza el stub (`npm start`) y asegúrate de que el archivo `last-inventory.json`
   refleje el inventario actual.
2. Realiza un cambio de inventario en Shopify (o reenvía el webhook
   `inventory_levels/update`) y confirma que el job encolado en `logs/jobs` incluya el
   bloque `<InventorySiteRef>` correcto.
3. Ejecuta el QuickBooks Web Connector para sincronizar el job. Al terminar revisa
   `http://localhost:PORT/debug/last-response` y verifica que el nodo `<QBWCXML>` de la
   respuesta de QuickBooks tenga `statusCode="0"`.
4. Comprueba en QuickBooks Desktop que el inventario del artículo se actualizó en el
   sitio correspondiente.

> Nota: el Web Connector y QuickBooks Desktop no están disponibles dentro de este
> entorno de desarrollo. Realiza estas validaciones en la instalación local donde se
> ejecuta la integración.
