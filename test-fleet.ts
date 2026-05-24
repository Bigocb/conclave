#!/usr/bin/env npx tsx
import { FleetManager } from './src/fleet/manager.js';
import { parseFleetConfig } from './src/fleet/config.js';

const config = parseFleetConfig('fleet.yaml');
console.log('Reviewers:', JSON.stringify(config.reviewers, null, 2));

const manager = new FleetManager(config);
console.log('Provisioning...');
await manager.provision();
console.log('Provisioned!');

const stats = manager.getStats();
console.log('Stats:', JSON.stringify(stats, null, 2));

// Run one poll cycle manually
console.log('\nStarting polling...');

// Give it time to poll and review
await new Promise(r => setTimeout(r, 5000));
console.log('Done');
process.exit(0);