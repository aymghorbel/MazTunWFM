// Single combined migration runner — avoids npm-run spinup overhead between migrations.
// Spawns `node` directly for each migration (no npm registry checks).
const { spawnSync } = require('child_process');
const path = require('path');

const migrations = [
  'init.js',
  'add_azure_sso.js',
  'remove_capex.js',
  'add_workflows.js',
  'seed_default_workflows.js',
  'add_project_expiry.js',
  'add_company_entities.js',
  'add_approval_chain.js',
  'add_workflow_designer.js',
  'add_erp_rota.js',
  'add_missing_columns.js',
  'drop_project_type.js',
  'add_departments_and_balances.js',
];

const start = Date.now();
let failed = false;

for (const m of migrations) {
  const t0 = Date.now();
  console.log(`\n▶ ${m}`);
  const result = spawnSync('node', [path.join(__dirname, m)], {
    stdio: 'inherit',
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  if (result.status !== 0) {
    console.error(`✗ ${m} exited with code ${result.status}`);
    failed = true;
  } else {
    console.log(`✓ ${m} (${Date.now() - t0}ms)`);
  }
}

console.log(`\n${failed ? '⚠️ ' : '✅ '}all migrations finished in ${Date.now() - start}ms`);
process.exit(failed ? 1 : 0);
