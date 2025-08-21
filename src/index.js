// src/index.js
'use strict';

/**
 * App Express + SOAP para QuickBooks Web Connector
 * - Mantiene autenticación y flujo basado en cola de jobs.
 * - Guarda last-request-qbxml.xml y last-response.xml en /tmp.
 * - Hook: parsea y persiste inventario a /tmp/last-inventory.json tras recibir respuesta.
 * - Endpoints de depuración: /debug/config, /debug/where, /debug/queue, /debug/seed-inventory, /debug/inventory, /debug/last-response
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { randomUUID } = require('crypto');

let soap;
try { soap = require('soap'); } catch { console.error('Falta dependencia "soap". Instala con: npm i soap'); }

// ---------- Config ----------
try { require('dotenv').config(); } catch {}
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SOAP_PATH = process.env.QBWC_PATH || '/qbwc';
const COMPANY_FILE = process.env.COMPANY_FILE || ''; // si quieres devolver un .qbw específico

// ---------- Helpers de rutas/archivos ----------
const TMP_DIR = '/tmp';
const fp = (name) => path.join(TMP_DIR, name);

function sendFileSmart(res, fullpath) {
  if (!fs.existsSync(fullpath)) {
    return res.status(404).json({ error: `Not found: ${fullpath}` });
  }
  const ext = path.extname(fullpath).toLowerCase();
  if (ext === '.xml') res.setHeader('Content-Type', 'application/xml');
  else if (ext === '.json') res.setHeader('Content-Type', 'application/json');
  return fs.createReadStream(fullpath).pipe(res);
}

// ---------- Persistencia simple de cola ----------
const QUEUE_PATH = fp('jobs-queue.json');

function readJobs() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) || [];
  } catch {
    return [];
  }
}
function writeJobs(arr) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(arr || [], null, 2), 'utf8');
}
function enqueue(job) {
  const q = readJobs();
  q.push(job);
  writeJobs(q);
  return q.length;
}
function peekJob() {
  const q = readJobs();
  return q.length ? q[0] : null;
}
function shiftJob() {
  const q = readJobs();
  const job = q.shift();
  writeJobs(q);
  return job;
}

// ---------- Servicios desacoplados ----------
const { buildInventoryQueryXML } = require('./services/inventory');
const { parseAndPersistInventory } = require('./services/inventory-parse');

// Generador de QBXML por tipo de job (puedes añadir más tipos aquí si los usas)
function qbxmlFor(job) {
  if (!job || !job.type) return '';

  if (job.type === 'inventoryQuery') {
    const max = Number(job.max) || Number(process.env.INVENTORY_MAX || 50);
    const ver = process.env.QBXML_VER || '16.0';
    return buildInventoryQueryXML(max, ver);
  }

  // otros tipos...
  return '';
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/', (_req, res) => res.status(200).send('OK'));

// ----- Debug endpoints -----
app.get('/debug/config', (_req, res) => {
  res.json({
    port: PORT,
    host: HOST,
    publicUrl: PUBLIC_URL,
    soapPath: SOAP_PATH,
    companyFile: COMPANY_FILE || '(open company file)',
    qbxmlVer: process.env.QBXML_VER || '16.0',
    inventoryMax: Number(process.env.INVENTORY_MAX || 50),
  });
});

app.get('/debug/where', (_req, res) => {
  const files = [
    'last-request-qbxml.xml',
    'last-response.xml',
    'last-inventory.json',
    'jobs-queue.json',
  ];
  const payload = {};
  files.forEach((f) => {
    const p = fp(f);
    payload[f] = { path: p, exists: fs.existsSync(p) };
  });
  res.json(payload);
});

app.get('/debug/queue', (_req, res) => res.json(readJobs()));

app.get('/debug/seed-inventory', (req, res) => {
  const max = Number(req.query.max) || Number(process.env.INVENTORY_MAX || 50);
  enqueue({ type: 'inventoryQuery', max, ts: new Date().toISOString() });
  res.json({ ok: true, queued: { type: 'inventoryQuery', max } });
});

app.get('/debug/inventory', (_req, res) => {
  const invPath = fp('last-inventory.json');
  if (!fs.existsSync(invPath)) return res.json({ count: 0, items: [] });
  try {
    const json = JSON.parse(fs.readFileSync(invPath, 'utf8'));
    return res.json({ count: json.count || (json.items?.length || 0), items: json.items || [] });
  } catch (e) {
    return res.status(500).json({ error: 'Invalid inventory file', details: String(e) });
  }
});

app.get('/debug/last-response', (_req, res) => sendFileSmart(res, fp('last-response.xml')));

// ---------- SOAP Service ----------
let lastErrorMessage = '';

function wsdlXml(baseUrl, soapPath) {
  const addr = `${baseUrl}${soapPath}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="QBWebConnectorSvc"
  targetNamespace="http://developer.intuit.com/"
  xmlns:tns="http://developer.intuit.com/"
  xmlns:typens="http://developer.intuit.com/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">

  <types>
    <xsd:schema targetNamespace="http://developer.intuit.com/">
      <xsd:complexType name="ArrayOfString">
        <xsd:sequence>
          <xsd:element name="string" type="xsd:string" minOccurs="0" maxOccurs="unbounded"/>
        </xsd:sequence>
      </xsd:complexType>
    </xsd:schema>
  </types>

  <message name="serverVersionRequest"/>
  <message name="serverVersionResponse">
    <part name="serverVersionResult" type="xsd:string"/>
  </message>

  <message name="clientVersionRequest">
    <part name="productVersion" type="xsd:string"/>
  </message>
  <message name="clientVersionResponse">
    <part name="clientVersionResult" type="xsd:string"/>
  </message>

  <message name="authenticateRequest">
    <part name="strUserName" type="xsd:string"/>
    <part name="strPassword" type="xsd:string"/>
  </message>
  <message name="authenticateResponse">
    <part name="authenticateResult" type="typens:ArrayOfString"/>
  </message>

  <message name="sendRequestXMLRequest">
    <part name="ticket" type="xsd:string"/>
    <part name="strHCPResponse" type="xsd:string"/>
    <part name="strCompanyFileName" type="xsd:string"/>
    <part name="qbXMLCountry" type="xsd:string"/>
    <part name="qbXMLMajorVers" type="xsd:int"/>
    <part name="qbXMLMinorVers" type="xsd:int"/>
  </message>
  <message name="sendRequestXMLResponse">
    <part name="sendRequestXMLResult" type="xsd:string"/>
  </message>

  <message name="receiveResponseXMLRequest">
    <part name="ticket" type="xsd:string"/>
    <part name="response" type="xsd:string"/>
    <part name="hresult" type="xsd:string"/>
    <part name="message" type="xsd:string"/>
  </message>
  <message name="receiveResponseXMLResponse">
    <part name="receiveResponseXMLResult" type="xsd:int"/>
  </message>

  <message name="connectionErrorRequest">
    <part name="ticket" type="xsd:string"/>
    <part name="hresult" type="xsd:string"/>
    <part name="message" type="xsd:string"/>
  </message>
  <message name="connectionErrorResponse">
    <part name="connectionErrorResult" type="xsd:string"/>
  </message>

  <message name="getLastErrorRequest">
    <part name="ticket" type="xsd:string"/>
  </message>
  <message name="getLastErrorResponse">
    <part name="getLastErrorResult" type="xsd:string"/>
  </message>

  <message name="closeConnectionRequest">
    <part name="ticket" type="xsd:string"/>
  </message>
  <message name="closeConnectionResponse">
    <part name="closeConnectionResult" type="xsd:string"/>
  </message>

  <portType name="QBWebConnectorSvcSoap">
    <operation name="serverVersion">
      <input message="tns:serverVersionRequest"/>
      <output message="tns:serverVersionResponse"/>
    </operation>
    <operation name="clientVersion">
      <input message="tns:clientVersionRequest"/>
      <output message="tns:clientVersionResponse"/>
    </operation>
    <operation name="authenticate">
      <input message="tns:authenticateRequest"/>
      <output message="tns:authenticateResponse"/>
    </operation>
    <operation name="sendRequestXML">
      <input message="tns:sendRequestXMLRequest"/>
      <output message="tns:sendRequestXMLResponse"/>
    </operation>
    <operation name="receiveResponseXML">
      <input message="tns:receiveResponseXMLRequest"/>
      <output message="tns:receiveResponseXMLResponse"/>
    </operation>
    <operation name="connectionError">
      <input message="tns:connectionErrorRequest"/>
      <output message="tns:connectionErrorResponse"/>
    </operation>
    <operation name="getLastError">
      <input message="tns:getLastErrorRequest"/>
      <output message="tns:getLastErrorResponse"/>
    </operation>
    <operation name="closeConnection">
      <input message="tns:closeConnectionRequest"/>
      <output message="tns:closeConnectionResponse"/>
    </operation>
  </portType>

  <binding name="QBWebConnectorSvcSoap" type="tns:QBWebConnectorSvcSoap">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="serverVersion">
      <soap:operation soapAction="http://developer.intuit.com/serverVersion"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="clientVersion">
      <soap:operation soapAction="http://developer.intuit.com/clientVersion"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="authenticate">
      <soap:operation soapAction="http://developer.intuit.com/authenticate"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="sendRequestXML">
      <soap:operation soapAction="http://developer.intuit.com/sendRequestXML"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="receiveResponseXML">
      <soap:operation soapAction="http://developer.intuit.com/receiveResponseXML"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="connectionError">
      <soap:operation soapAction="http://developer.intuit.com/connectionError"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="getLastError">
      <soap:operation soapAction="http://developer.intuit.com/getLastError"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="closeConnection">
      <soap:operation soapAction="http://developer.intuit.com/closeConnection"/>
      <input><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="http://developer.intuit.com/" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
  </binding>

  <service name="QBWebConnectorSvc">
    <port name="QBWebConnectorSvcSoap" binding="tns:QBWebConnectorSvcSoap">
      <soap:address location="${addr}"/>
    </port>
  </service>
</definitions>`;
}

const soapService = {
  QBWebConnectorSvc: {
    QBWebConnectorSvcSoap: {
      serverVersion(_args, cb) {
        // Coincide con lo que tu WC mostró en el log
        return cb(null, { serverVersionResult: '1.0.0-dev' });
      },
      clientVersion(_args, cb) {
        // Cadena vacía = permitir
        return cb(null, { clientVersionResult: '' });
      },
      authenticate(args, cb) {
        try {
          const user = args?.strUserName || '';
          const pass = args?.strPassword || '';

          // Si defines QBWC_USERNAME/QBWC_PASSWORD, se validan; de lo contrario, aceptar.
          const confUser = process.env.QBWC_USERNAME;
          const confPass = process.env.QBWC_PASSWORD;
          const acceptAny = !confUser && !confPass;
          const ok = acceptAny || (user === confUser && pass === confPass);

          if (!ok) return cb(null, { authenticateResult: { string: ['', 'nvu'] } });

          const ticket = randomUUID();
          // Devuelve el company file si definiste COMPANY_FILE; si no, usa el abierto
          const cfn = COMPANY_FILE;

          // Auto-sembrar inventario al autenticarse (opcional via env)
          if (process.env.AUTO_SEED_ON_AUTH === 'true') {
            enqueue({ type: 'inventoryQuery', max: Number(process.env.INVENTORY_MAX || 50), ts: new Date().toISOString() });
          }

          // Algunos WSDL aceptan array de 2 o de 4 strings; devolvemos 4 por compatibilidad
          return cb(null, { authenticateResult: { string: [ticket, cfn, '', ''] } });
        } catch (err) {
          lastErrorMessage = `authenticate error: ${String(err)}`;
          return cb(null, { authenticateResult: { string: ['', 'nvu'] } });
        }
      },
      sendRequestXML(args, cb) {
        try {
          // Si no hay job, no hay trabajo -> devuelve vacío para cerrar sesión
          const job = peekJob();
          if (!job) return cb(null, { sendRequestXMLResult: '' });

          const xml = qbxmlFor(job) || '';
          fs.writeFileSync(fp('last-request-qbxml.xml'), xml, 'utf8');
          return cb(null, { sendRequestXMLResult: xml });
        } catch (err) {
          lastErrorMessage = `sendRequestXML error: ${String(err)}`;
          return cb(null, { sendRequestXMLResult: '' });
        }
      },
      receiveResponseXML(args, cb) {
        try {
          const response = args?.response || args?.responseXML || '';

          // Guardar el XML crudo
          fs.writeFileSync(fp('last-response.xml'), response, 'utf8');

          // ---- HOOK: parsear y persistir inventario si aplica ----
          try {
            if (response && response.includes('<ItemInventoryQueryRs')) {
              parseAndPersistInventory(response);
            }
          } catch (e) {
            console.error('Inventory parse error:', e);
          }
          // --------------------------------------------------------

          // Marcamos el job como completado (flujo simple: 1 request = 1 job)
          const current = peekJob();
          if (current) shiftJob();

          // 100 = no hay más por procesar de este request
          return cb(null, { receiveResponseXMLResult: 100 });
        } catch (err) {
          lastErrorMessage = `receiveResponseXML error: ${String(err)}`;
          // Devuelve 100 para no ciclar
          return cb(null, { receiveResponseXMLResult: 100 });
        }
      },
      connectionError(args, cb) {
        const hresult = args?.hresult || '';
        const message = args?.message || '';
        lastErrorMessage = `connectionError: hresult=${hresult} message=${message}`;
        return cb(null, { connectionErrorResult: lastErrorMessage });
      },
      getLastError(_args, cb) {
        return cb(null, { getLastErrorResult: lastErrorMessage || '' });
      },
      closeConnection(_args, cb) {
        return cb(null, { closeConnectionResult: 'OK' });
      },
    },
  },
};

// ---------- Montar servidor ----------
const server = http.createServer(app);

if (!soap) {
  // Arranca sin SOAP para no tumbar el sitio si falta la dependencia
  server.listen(PORT, HOST, () => {
    console.log(`[server] Listening (NO SOAP) on http://${HOST}:${PORT}`);
    console.log(`[debug] GET /debug/inventory | /debug/last-response | /debug/queue`);
  });
} else {
  const wsdl = wsdlXml(PUBLIC_URL, SOAP_PATH);
  soap.listen(server, SOAP_PATH, soapService, wsdl);
  server.listen(PORT, HOST, () => {
    console.log(`[server] Listening on http://${HOST}:${PORT}`);
    console.log(`[soap] WSDL at ${PUBLIC_URL}${SOAP_PATH}?wsdl`);
    console.log(`[debug] GET /debug/inventory | /debug/last-response | /debug/queue`);
  });
}