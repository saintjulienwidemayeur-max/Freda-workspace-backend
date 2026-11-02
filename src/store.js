/** Stockage JSON atomique (commandes, domaines, clés d'idempotence). À remplacer par PostgreSQL/Supabase en production. */
const fs = require('fs');
const path = require('path');

function createStore(file) {
  const abs = path.resolve(file);
  let data = { orders: {}, domains: [], idempotency: {} };
  if (fs.existsSync(abs)) { try { data = { ...data, ...JSON.parse(fs.readFileSync(abs, 'utf8')) }; } catch (e) { throw new Error('Fichier de données illisible : ' + abs); } }
  function persist() {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, abs);
  }
  return {
    getOrder: (id) => data.orders[id] || null,
    saveOrder(o) { data.orders[o.id] = o; persist(); return o; },
    listOrders: (userId) => Object.values(data.orders).filter((o) => o.userId === userId),
    addDomain(d) { data.domains.push(d); persist(); },
    domainsOf: (userId) => data.domains.filter((d) => d.userId === userId),
    hasDomain: (name) => data.domains.some((d) => d.name === name),
    idem: (userId, key) => data.idempotency[userId + ':' + key] || null,
    setIdem(userId, key, orderId) { data.idempotency[userId + ':' + key] = orderId; persist(); },
  };
}
module.exports = { createStore };
