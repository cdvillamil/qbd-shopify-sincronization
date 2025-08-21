// index.js
'use strict';

/**
 * Servidor Express + SOAP para QuickBooks Web Connector
 * - Mantiene autenticación (usa QBWC_USERNAME/QBWC_PASSWORD si existen)
 * - Rutas de depuración: /debug/last-response y /debug/inventory
 * - Servicio SOAP expuesto en /qbwc (configurable con QBWC_PATH)
 * - Usa ./wsdl/qbwc.wsdl si existe; si no, WSDL embebido (address toma PUBLIC_URL)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const soap = require('soap');
const { randomUUID } = require('crypto');

// Carga .env si existe
try { require('dotenv').config(); } catch (_) {}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SOAP_PATH = process.env.QBWC_PATH || '/qbwc';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const app = express();

// Middlewares básicos
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Importa tu servicio ubicado en ./services/qbwcService.js
// (si tu archivo se llama distinto, ajusta este require)
const qbwcService = require(path.join(__dirname, 'services', 'qbwcService'));

// Healthcheck
app.get('/', (_req, res) => res.status(200).send('OK'));

// ----------------------
// Rutas de depuración
// ----------------------
app.get('/debug/last-response', (_req, res) => {
  try {
    const dbg = qbwcService.getDebugInfo();
    return res.status(200).json({
      updatedAt: dbg.updatedAt,
      lastRequestXml: dbg.lastRequestXml,
      lastResponseXml: dbg.lastResponseXml,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Unable to read last response', details: String(err) });
  }
});

app.get('/debug/inventory', (_req, res) => {
  try {
    const inv = qbwcService.getInventory();
    return res.status(200).json(inv);
  } catch (err) {
    return res.status(500).json({ error: 'Unable to read inventory', details: String(err) });
  }
});

// ==========================
// Servicio SOAP (QBWC)
// ==========================
let lastErrorMessage = '';

function authenticateHandler(args) {
  const user = args?.strUserName || '';
  const pass = args?.strPassword || '';

  const confUser = process.env.QBWC_USERNAME;
  const confPass = process.env.QBWC_PASSWORD;

  const acceptAny = !confUser && !confPass;
  const isValid = acceptAny || (user === confUser && pass === confPass);

  if (!isValid) return ['', 'nvu']; // not valid user

  const ticket = randomUUID();
  const companyFile = ''; // usar el archivo abierto en QBD
  return [ticket, companyFile];
}

function sendRequestXMLHandler() {
  try {
    const qbxml = qbwcService.sendRequestXML();
    return qbxml || '';
  } catch (err) {
    lastErrorMessage = `sendRequestXML error: ${String(err)}`;
    return '';
  }
}

function receiveResponseXMLHandler(args) {
  try {
    const response = args?.response || args?.responseXML || '';
    const percent = qbwcService.receiveResponseXML(response);
    return Number.isFinite(percent) ? percent : 100;
  } catch (err) {
    lastErrorMessage = `receiveResponseXML error: ${String(err)}`;
    return 100;
  }
}

function closeConnectionHandler() {
  try {
    return qbwcService.closeConnection() || 'OK';
  } catch {
    return 'OK';
  }
}

function connectionErrorHandler(args) {
  const hresult = args?.hresult || '';
  const message = args?.message || '';
  lastErrorMessage = `connectionError: hresult=${hresult} message=${message}`;
  return lastErrorMessage || 'Connection error received';
}

function getLastErrorHandler() {
  return lastErrorMessage || '';
}

const soapService = {
  QBWebConnectorSvc: {
    QBWebConnectorSvcSoap: {
      authenticate(args, cb) {
        try {
          const arr = authenticateHandler(args);
          return cb(null, { authenticateResult: { string: arr } });
        } catch (err) {
          lastErrorMessage = `authenticate error: ${String(err)}`;
          return cb(null, { authenticateResult: { string: ['', 'nvu'] } });
        }
      },
      sendRequestXML(args, cb) {
        const xml = sendRequestXMLHandler(args);
        return cb(null, { sendRequestXMLResult: xml });
      },
      receiveResponseXML(args, cb) {
        const pct = receiveResponseXMLHandler(args);
        return cb(null, { receiveResponseXMLResult: pct });
      },
      connectionError(args, cb) {
        const msg = connectionErrorHandler(args);
        return cb(null, { connectionErrorResult: msg });
      },
      getLastError(args, cb) {
        const msg = getLastErrorHandler(args);
        return cb(null, { getLastErrorResult: msg });
      },
      closeConnection(args, cb) {
        const msg = closeConnectionHandler(args);
        return cb(null, { closeConnectionResult: msg });
      },
    },
  },
};

// ----------------------
// WSDL: usa ./wsdl/qbwc.wsdl si existe; si no, embebido
// ----------------------
function getEmbeddedWsdl(baseUrl, soapPath) {
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

function loadWsdl() {
  const localWsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
  try {
    if (fs.existsSync(localWsdlPath)) {
      return fs.readFileSync(localWsdlPath, 'utf8');
    }
  } catch (_) {}
  return getEmbeddedWsdl(PUBLIC_URL, SOAP_PATH);
}

// ----------------------
// Levantar HTTP + SOAP
// ----------------------
const server = http.createServer(app);
const wsdlXml = loadWsdl();

// Monta listener SOAP (sirve WSDL en /qbwc?wsdl)
soap.listen(server, SOAP_PATH, soapService, wsdlXml);

server.listen(PORT, HOST, () => {
  console.log(`[server] Listening on http://${HOST}:${PORT}`);
  console.log(`[soap] WSDL at ${PUBLIC_URL}${SOAP_PATH}?wsdl`);
  console.log(`[debug] GET /debug/inventory | /debug/last-response`);
});