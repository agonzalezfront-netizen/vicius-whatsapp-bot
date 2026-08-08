// Lee logs de un servicio Railway (para debugging del bot). Uso:
//   node scripts/railway-logs.mjs list                      → lista servicios + latest deployment
//   node scripts/railway-logs.mjs <deploymentId> [filtro]   → logs del deployment, opcional grep
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = fs.readFileSync(path.join(os.homedir(), '.pulsed', 'railway-token.txt'), 'utf8').trim();
const ENV_ID = '8dd2f065-8784-43f4-9867-b821ec5c8bd4';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function gql(query, variables) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'User-Agent': UA },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const [arg, filtro] = process.argv.slice(2);

if (!arg || arg === 'list') {
  const q = `query($id: String!) {
    environment(id: $id) {
      serviceInstances { edges { node {
        serviceId serviceName
        latestDeployment { id status createdAt staticUrl }
      } } }
    }
  }`;
  const d = await gql(q, { id: ENV_ID });
  for (const e of d.environment.serviceInstances.edges) {
    const n = e.node;
    console.log(`${n.serviceName}\n  serviceId: ${n.serviceId}\n  deployment: ${n.latestDeployment?.id} (${n.latestDeployment?.status}, ${n.latestDeployment?.createdAt})`);
  }
} else {
  const q = `query($id: String!) {
    deploymentLogs(deploymentId: $id, limit: 500) { message timestamp }
  }`;
  const d = await gql(q, { id: arg });
  const rx = filtro ? new RegExp(filtro, 'i') : null;
  for (const l of d.deploymentLogs) {
    if (!rx || rx.test(l.message)) console.log(l.timestamp, l.message);
  }
}
