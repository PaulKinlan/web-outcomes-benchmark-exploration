#!/usr/bin/env node
import { listProviderBridges, installProviderBridge } from '../src/harness/provider-bridges.mjs';
import { resetExtensionModelsCache, getPiExtensionModels } from '../src/harness/pi-auth-bridge.mjs';

const [, , action = 'list', targetId = null, customSource = null] = process.argv;

async function main() {
  if (action === 'list') {
    const bridges = listProviderBridges();
    console.log('\nClean-Room Provider Transport Bridges:\n');
    for (const b of bridges) {
      const status = b.installed
        ? `INSTALLED (${b.version} via ${b.source})`
        : b.builtInAuthSupported
          ? 'BUILT-IN AUTH READY (optional -e override available)'
          : 'NOT INSTALLED';
      console.log(`  • ${b.id.padEnd(15)} [${status}]`);
      console.log(`      Providers:   ${(b.providers || []).join(', ')}`);
      if (b.entrypoints?.length) {
        console.log(`      Entrypoints: ${b.entrypoints.join(', ')}`);
      }
      if (b.envOverrideVar) {
        console.log(`      Env Override: ${b.envOverrideVar}=/path/to/extension.ts`);
      }
    }
    const extModels = await getPiExtensionModels();
    if (extModels.size > 0) {
      console.log('\nDiscovered Clean-Room Bridge Models (`pi --no-extensions -e <bridge> --list-models`):');
      for (const [prov, set] of extModels.entries()) {
        console.log(`  ✓ ${prov}: ${set.size} models (${Array.from(set).slice(0, 5).join(', ')}${set.size > 5 ? ', ...' : ''})`);
      }
    }
    console.log('');
    return;
  }

  if (action === 'install') {
    if (!targetId) {
      console.error(
        'Usage:\n' +
          '  npm run bridges:install -- <bridgeId> [npm-pkg | git+https://... | ./local/path]\n' +
          'Examples:\n' +
          '  npm run bridges:install -- antigravity\n' +
          '  npm run bridges:install -- claude-bridge ./extensions/claude-bridge\n' +
          '  npm run bridges:install -- muse git+https://github.com/org/pi-muse.git'
      );
      process.exit(1);
    }
    const installed = installProviderBridge(targetId, customSource);
    resetExtensionModelsCache();
    console.log(
      `[bridges] Installed "${installed.id}" (${installed.version}) -> ${installed.entrypoints.join(', ')}`
    );
    return;
  }

  console.error(`Unknown action "${action}". Use "list" or "install".`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[bridges] Error: ${err.message}`);
  process.exit(1);
});
