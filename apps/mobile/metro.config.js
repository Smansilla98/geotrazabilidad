// Metro: incluye packages/shared (dependencia file:) y resuelve módulos desde la raíz del monorepo.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(monorepoRoot, 'packages/shared')];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules'), path.join(monorepoRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = false;
module.exports = config;
