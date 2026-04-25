#!/usr/bin/env node
const fs = require('fs');
const WIKI_FILE = 'test_wiki.jsonl';

const data = [
  {"id":"C001","kind":"claim","tags":["gateway","502"],"text":"Payment gateway returns 502 Bad Gateway","resolves":"Why is checkout failing for all users?"},
  {"id":"O001","kind":"obs","supports":["C001"],"polarity":"+","etype":"live","text":"Datadog logs show 100% 502 rate on /checkout"},
  {"id":"C002","kind":"claim","tags":["nginx"],"text":"Nginx reverse proxy is dropping backend connections","resolves":"Is nginx correctly configured?"},
  {"id":"O002","kind":"obs","supports":["C002"],"polarity":"-","etype":"live","text":"systemctl status nginx shows active and routing correctly"},
  {"id":"C003","kind":"claim","tags":["backend","crash"],"text":"Node.js payment-service is in a crash loop","resolves":"Is the backend stable?"},
  {"id":"O003","kind":"obs","supports":["C003"],"polarity":"+","etype":"live","text":"pm2 logs show payment-service restarting every 2s"},
  {"id":"O004","kind":"obs","supports":["C003"],"polarity":"+","etype":"live","text":"Crash error: ECONNREFUSED to database.internal:5432"},
  {"id":"C004","kind":"claim","tags":["database","network"],"text":"Database server is unreachable on the internal network"},
  {"id":"O005","kind":"obs","supports":["C004"],"polarity":"-","etype":"live","text":"ping db.internal returns 0% packet loss"},
  {"id":"C005","kind":"claim","tags":["database","auth"],"text":"Database credentials are invalid or rejected","resolves":"Are the DB secrets correct?"},
  {"id":"O006","kind":"obs","supports":["C005"],"polarity":"+","etype":"live","text":"psql -U payment_user returns FATAL: password authentication failed"},
  {"id":"C006","kind":"claim","tags":["aws","secrets"],"text":"AWS SecretsManager is unreachable or rate-limited"},
  {"id":"O007","kind":"obs","supports":["C006"],"polarity":"-","etype":"live","text":"aws secretsmanager get-secret-value works fine, no 429 errors"},
  {"id":"C007","kind":"claim","tags":["rotation","stale"],"text":"DB password was rotated but service is using cached old credentials","resolves":"Why are valid secrets failing?"},
  {"id":"O008","kind":"obs","supports":["C007"],"polarity":"+","etype":"artifact","text":"AWS CloudTrail shows secret rotation event at 09:30Z today"},
  {"id":"O009","kind":"obs","supports":["C007"],"polarity":"+","etype":"live","text":"pm2 show payment-service uptime is 14 days (started before rotation)"},
  {"id":"C008","kind":"claim","tags":["env","local"],"text":"Local .env.prod overrides the AWS Cloud Secrets","resolves":"Where are the secrets coming from?"},
  {"id":"S001","kind":"sus","supports":["C008"],"polarity":"+","confidence":0.8,"text":"Service might be pulling from local file first"},
  {"id":"O010","kind":"obs","supports":["C008"],"polarity":"+","etype":"artifact","text":"Found .env.prod on the instance containing stale database password"},
  {"id":"C009","kind":"claim","tags":["ci","deployment"],"text":"CI pipeline failed to clean up local env files on last deploy"},
  {"id":"O011","kind":"obs","supports":["C009"],"polarity":"-","etype":"artifact","text":"GitHub Actions log shows 'Cleanup' step finished successfully"},
  {"id":"C010","kind":"claim","tags":["manual","ssh"],"text":"A manual SSH session left a hidden backup file on the server"},
  {"id":"O012","kind":"obs","supports":["C010"],"polarity":"+","etype":"live","text":"ls -la found .env.prod.bak modified by user 'root' at 09:45Z"},
  {"id":"C011","kind":"claim","tags":["docker","networking"],"text":"Docker bridge network is isolated from DB vpc"},
  {"id":"S002","kind":"sus","supports":["C011"],"polarity":"-","confidence":0.6,"text":"Other containers on same bridge reach DB fine"},
  {"id":"C012","kind":"claim","tags":["dns","internal"],"text":"Internal DNS record for db.internal is stale"},
  {"id":"O013","kind":"obs","supports":["C012"],"polarity":"-","etype":"live","text":"dig +short db.internal returns correct cluster IP"},
  {"id":"C013","kind":"claim","tags":["firewall","ingress"],"text":"DB Security Group is blocking the new bridge CIDR"},
  {"id":"O014","kind":"obs","supports":["C013"],"polarity":"-","etype":"artifact","text":"AWS SG rules allow all ingress from 10.0.0.0/16"},
  {"id":"C014","kind":"claim","tags":["app","logic"],"text":"Application code is hardcoded to port 5432 and ignores config"},
  {"id":"S003","kind":"sus","supports":["C014"],"polarity":"-","confidence":0.9,"text":"I checked the code earlier, it definitely uses ConfigManager"}
];

fs.writeFileSync(WIKI_FILE, data.map(d => JSON.stringify(d)).join('\n'));
console.log(`Generated 30 mock entries in ${WIKI_FILE}`);
