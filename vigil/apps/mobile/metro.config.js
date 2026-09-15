const path = require('node:path');
const fs = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Bundle the workspace packages from source rather than from a build step.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// pnpm's store is a forest of symlinks; Metro must follow them to find deps.
config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = false;

/**
 * Resolve TypeScript's ESM `.js` specifiers back to the `.ts` files they mean.
 *
 * @vigil/core and @vigil/crypto are written as ES modules with explicit `.js`
 * extensions on relative imports — which is what Node and tsc require, and what
 * Metro does not understand. Rewriting the packages to drop the extensions
 * would make them non-standard everywhere else just to suit the bundler, so the
 * translation lives here instead: try the original specifier, and on failure
 * retry with `.ts` / `.tsx`.
 */
const TS_EXTENSIONS = ['.ts', '.tsx'];
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const base = moduleName.slice(0, -3);
    for (const ext of TS_EXTENSIONS) {
      const candidate = path.resolve(path.dirname(context.originModulePath), base + ext);
      if (fs.existsSync(candidate)) {
        return { type: 'sourceFile', filePath: candidate };
      }
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
