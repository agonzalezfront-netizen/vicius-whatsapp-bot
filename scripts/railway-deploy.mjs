// Deploy de un commit a un servicio Railway vía GraphQL (serviceInstanceDeployV2).
// UA de navegador: el Cloudflare de Railway da 403 a UA genérico (memoria 2026-06).
// Uso: node scripts/railway-deploy.mjs <serviceId> <commitSha>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = fs.readFileSync(path.join(os.homedir(), '.pulsed', 'railway-token.txt'), 'utf8').trim();
const ENV_ID = '8dd2f065-8784-43f4-9867-b821ec5c8bd4';
const [serviceId, commitSha] = process.argv.slice(2);
if (!serviceId || !commitSha) { console.error('uso: railway-deploy.mjs <serviceId> <commitSha>'); process.exit(2); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function gql(query, variables) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'User-Agent': UA },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const M = `mutation($serviceId: String!, $environmentId: String!, $commitSha: String) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
}`;
const d = await gql(M, { serviceId, environmentId: ENV_ID, commitSha });
console.log('deploy disparado:', JSON.stringify(d));
