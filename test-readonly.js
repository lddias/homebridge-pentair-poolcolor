'use strict';
// READ-ONLY test: discover the ScreenLogic unit, list circuits, read circuit states.
// Sends NO commands that change anything (no setCircuitState, no sendLightCommand).
const ScreenLogic = require('node-screenlogic');

function findUnit() {
  return new Promise((resolve, reject) => {
    const finder = new ScreenLogic.FindUnits();
    const timer = setTimeout(() => {
      try { finder.close(); } catch (e) {}
      reject(new Error('no ScreenLogic unit found via broadcast'));
    }, 20000);
    finder
      .on('serverFound', (server) => {
        clearTimeout(timer);
        try { finder.close(); } catch (e) {}
        resolve(server);
      })
      .on('error', (err) => { clearTimeout(timer); reject(err); });
    finder.search();
  });
}

function login(connection) {
  return new Promise((resolve, reject) => {
    connection
      .once('loggedIn', () => resolve())
      .once('loginFailed', () => reject(new Error('login failed')))
      .once('error', (err) => reject(err));
    connection.connect();
  });
}

(async () => {
  console.log('searching for ScreenLogic unit via broadcast...');
  const server = await findUnit();
  console.log('found unit:', server.gatewayName || server.ipAddr || JSON.stringify(server).slice(0, 120));

  const connection = new ScreenLogic.UnitConnection(server);
  await login(connection);
  console.log('logged in OK');

  const circuits = await new Promise((resolve, reject) => {
    connection
      .once('controllerConfig', (cfg) => resolve(cfg.bodyArray.map((c) => ({ id: c.circuitId, name: c.name }))))
      .once('error', reject);
    connection.once('version', () => connection.getControllerConfig());
    connection.getVersion();
  });
  console.log('circuits:');
  for (const c of circuits) console.log(`  ${c.id} = ${c.name}`);

  const states = await new Promise((resolve, reject) => {
    connection
      .once('poolStatus', (status) => {
        const m = new Map();
        for (const c of status.circuitArray) m.set(c.id, c.state);
        resolve(m);
      })
      .once('error', reject);
    connection.getPoolStatus();
  });
  console.log('light-circuit states:');
  for (const c of circuits) {
    if (/light/i.test(c.name)) console.log(`  ${c.name}: ${states.get(c.id) === 1 ? 'ON' : 'off'}`);
  }

  connection.close();
  console.log('READ-ONLY TEST PASSED');
  process.exit(0);
})().catch((err) => { console.error('TEST FAILED:', err.message); process.exit(1); });
