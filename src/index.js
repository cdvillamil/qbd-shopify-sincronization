'use strict';

const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
require('dotenv').config();

/* ===== Config ===== */
const PORT     = process.env.PORT || 8080;             // Azure Linux usa 8080
const BASE_PATH= process.env.BASE_PATH || '/qbwc';
const LOG_DIR  = process.env.LOG_DIR || '/tmp';
const TNS      = 'http://developer.intuit.com/';

function ensureLogDir(){ try{ fs.mkdirSync(LOG_DIR,{recursive:true}); }catch{} }
function fp(n){ return path.join(LOG_DIR,n); }
function save(name, txt){ ensureLogDir(); fs.writeFileSync(fp(name), txt??'', 'utf8'); }
function sendFileSmart(res, file){
  if(!fs.existsSync(file)) return res.status(404).send('not found');
  const s = fs.readFileSync(file,'utf8'); 
  const looksXml = s.trim().startsWith('<');
  const looksJson = s.trim().startsWith('{')||s.trim().startsWith('[');
  res.type(looksXml?'application/xml':looksJson?'application/json':'text/plain').send(s);
}
function extractCredsFromXml(xml){
  const u = xml.match(/<(?:\w*:)?(?:strUserName|userName|UserName)>([^<]*)<\/(?:\w*:)?(?:strUserName|userName|UserName)>/);
  const p = xml.match(/<(?:\w*:)?(?:strPassword|password|Password)>([^<]*)<\/(?:\w*:)?(?:strPassword|password|Password)>/);
  return { user:(u&&u[1])||'', pass:(p&&p[1])||'' };
}
function envelope(body){
  return `<?xml version="1.0" encoding="utf-8"?>`+
         `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`+
         `<soap:Body>${body}</soap:Body></soap:Envelope>`;
}

const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* ===== Health & Debug ===== */
app.get('/healthz', (_req,res)=>res.json({ok:true}));
app.get('/debug/config', (_req,res)=>res.json({
  user:process.env.WC_USERNAME||null,
  passLen:(process.env.WC_PASSWORD||'').length,
  companyFile:process.env.WC_COMPANY_FILE||null,
  basePath:BASE_PATH, logDir:LOG_DIR
}));
app.get('/debug/where', (_req,res)=>{
  try{
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR).map(n=>{
      const st=fs.statSync(fp(n)); return {name:n,size:st.size,mtime:st.mtime};
    });
    res.json({logDir:LOG_DIR, files});
  }catch(e){ res.status(500).send(String(e)); }
});
app.get('/debug/last-post-body', (req,res)=>sendFileSmart(res, fp('last-post-body.xml')));
app.get('/debug/last-auth-request', (req,res)=>sendFileSmart(res, fp('last-auth-request.xml')));
app.get('/debug/last-auth-response',(req,res)=>sendFileSmart(res, fp('last-auth-response.xml')));
app.get('/debug/last-auth-cred', (req,res)=>{
  const p=fp('last-auth-cred.json'); if(!fs.existsSync(p)) return res.status(404).send('no auth cred yet');
  res.type('application/json').send(fs.readFileSync(p,'utf8'));
});

/* ===== WSDL (acepta ?wsdl aunque venga vacío) ===== */
app.get(BASE_PATH, (req,res,next)=>{
  if (!('wsdl' in req.query)) return next();      // solo si existe el parámetro
  try{
    const wsdlPath = path.join(__dirname,'wsdl','qbwc.wsdl');
    const xml = fs.readFileSync(wsdlPath,'utf8');
    res.type('application/xml').send(xml);
  }catch(e){ res.status(500).send(String(e)); }
});

/* ===== Handler SOAP manual (todos los métodos mínimos) ===== */
app.post(BASE_PATH, (req,res)=>{
  let raw=''; req.setEncoding('utf8');
  req.on('data', c=>{ raw+=c; });
  req.on('end', ()=>{
    try{
      save('last-post-body.xml', raw);

      // Identificar método por etiqueta en el XML
      const is = (tag)=> raw.includes(`<${tag}`) || raw.includes(`<tns:${tag}`);
      let bodyXml = '';

      if (is('serverVersion')) {
        bodyXml = `<serverVersionResponse xmlns="${TNS}"><serverVersionResult>1.0.0-dev</serverVersionResult></serverVersionResponse>`;
      }
      else if (is('clientVersion')) {
        // cadena vacía => permitir
        bodyXml = `<clientVersionResponse xmlns="${TNS}"><clientVersionResult></clientVersionResult></clientVersionResponse>`;
      }
      else if (is('authenticate')) {
        save('last-auth-request.xml', raw);
        const {user,pass} = extractCredsFromXml(raw);
        const envUser = process.env.WC_USERNAME || '';
        const envPass = process.env.WC_PASSWORD || '';
        const ok = (user===envUser && pass===envPass);

        const passSha = crypto.createHash('sha256').update(pass||'', 'utf8').digest('hex');
        const envSha  = crypto.createHash('sha256').update(envPass, 'utf8').digest('hex');
        save('last-auth-cred.json', JSON.stringify({
          ts:new Date().toISOString(),
          receivedUser:user, receivedPassLen:(pass||'').length, receivedPassSha256:passSha,
          envUser, envPassLen:envPass.length, envPassSha256:envSha,
          matchUser:user===envUser, matchPassHash:passSha===envSha
        },null,2));

        const ticket = ok ? (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')) : '';
        const second = ok ? ((process.env.WC_COMPANY_FILE||'none')) : 'nvu'; // ruta .QBW o 'none' / 'nvu'
        bodyXml = `<authenticateResponse xmlns="${TNS}"><authenticateResult><string>${ticket}</string><string>${second}</string></authenticateResult></authenticateResponse>`;
        const envlp = envelope(bodyXml);
        save('last-auth-response.xml', envlp);
        res.type('text/xml').status(200).send(envlp);
        return;
      }
      else if (is('sendRequestXML')) {
        // Devolvemos cadena vacía para indicar "no hay trabajo".
        bodyXml = `<sendRequestXMLResponse xmlns="${TNS}"><sendRequestXMLResult></sendRequestXMLResult></sendRequestXMLResponse>`;
      }
      else if (is('receiveResponseXML')) {
        // Devolver porcentaje completado (0-100). 100 => terminado.
        bodyXml = `<receiveResponseXMLResponse xmlns="${TNS}"><receiveResponseXMLResult>100</receiveResponseXMLResult></receiveResponseXMLResponse>`;
      }
      else if (is('getLastError')) {
        // Devuelve cadena vacía si no hay error pendiente.
        bodyXml = `<getLastErrorResponse xmlns="${TNS}"><getLastErrorResult></getLastErrorResult></getLastErrorResponse>`;
      }
      else if (is('closeConnection')) {
        // Mensaje de cierre amigable
        bodyXml = `<closeConnectionResponse xmlns="${TNS}"><closeConnectionResult>OK</closeConnectionResult></closeConnectionResponse>`;
      }
      else {
        // Método no soportado en el stub
        const fault = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Client</faultcode>
      <faultstring>Method not implemented in stub</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;
        res.type('text/xml').status(200).send(fault);
        return;
      }

      // Enviar respuesta normal
      const envlp = envelope(bodyXml);
      res.type('text/xml').status(200).send(envlp);
    }catch(e){
      res.status(500).type('text/plain').send(String(e));
    }
  });
});

/* ===== Start ===== */
app.listen(PORT, ()=> console.log(`[QBWC STUB] Listening on http://localhost:${PORT}${BASE_PATH}`));
