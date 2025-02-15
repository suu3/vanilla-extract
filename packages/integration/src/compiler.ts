import { join, isAbsolute } from 'path';
import type { Adapter } from '@vanilla-extract/css';
import { transformCss } from '@vanilla-extract/css/transformCss';
import type { ModuleNode, InlineConfig as ViteConfig } from 'vite';

import type { IdentifierOption } from './types';
import { cssFileFilter } from './filters';
import { getPackageInfo } from './packageInfo';
import { transform } from './transform';
import { normalizePath } from './addFileScope';
import { lock } from './lock';
import { serializeVanillaModule } from './processVanillaFile';

type Css = Parameters<Adapter['appendCss']>[0];
type Composition = Parameters<Adapter['registerComposition']>[0];

const globalAdapterIdentifier = '__vanilla_globalCssAdapter__';

const scanModule = (entryModule: ModuleNode) => {
  const queue = new Set([entryModule]);
  const cssDeps = new Set<string>();
  const watchFiles = new Set<string>();

  for (const moduleNode of queue) {
    if (moduleNode.id?.includes('@vanilla-extract/')) {
      continue;
    }

    if (moduleNode.id && cssFileFilter.test(moduleNode.id)) {
      cssDeps.add(moduleNode.id);
    }
    if (moduleNode.file) {
      watchFiles.add(moduleNode.file);
    }

    for (const dep of moduleNode.importedModules) {
      queue.add(dep);
    }
  }

  // This ensures the root module's styles are last in terms of CSS ordering
  const [head, ...tail] = cssDeps;

  return { cssDeps: [...tail, head], watchFiles };
};

const createViteServer = async ({
  root,
  identifiers,
  viteResolve,
  vitePlugins,
}: Required<Omit<CreateCompilerOptions, 'cssImportSpecifier'>>) => {
  const pkg = getPackageInfo(root);
  const vite = await import('vite');

  const server = await vite.createServer({
    configFile: false,
    root,
    server: {
      hmr: false,
    },
    logLevel: 'silent',
    optimizeDeps: {
      disabled: true,
    },
    ssr: {
      noExternal: true,
    },
    resolve: viteResolve,
    plugins: [
      {
        name: 'vanilla-extract-externalize',
        enforce: 'pre',
        async resolveId(source, importer) {
          if (source.startsWith('@vanilla-extract/')) {
            const result = await this.resolve(source, importer, {
              skipSelf: true,
            });

            return result ? { ...result, external: true } : null;
          }
        },
      },
      {
        name: 'vanilla-extract-transform',
        async transform(code, id) {
          if (cssFileFilter.test(id)) {
            const filescopedCode = await transform({
              source: code,
              rootPath: root,
              filePath: id,
              packageName: pkg.name,
              identOption: identifiers,
              globalAdapterIdentifier,
            });

            return filescopedCode;
          }
        },
      },
      ...vitePlugins,
    ],
  });

  // this is need to initialize the plugins
  await server.pluginContainer.buildStart({});

  const { ViteNodeRunner } = await import('vite-node/client');
  const { ViteNodeServer } = await import('vite-node/server');

  const node = new ViteNodeServer(server);

  class ViteNodeRunnerWithContext extends ViteNodeRunner {
    cssAdapter: Adapter | undefined;

    prepareContext(context: Record<string, any>): Record<string, any> {
      return {
        ...super.prepareContext(context),
        [globalAdapterIdentifier]: this.cssAdapter,
      };
    }
  }

  const runner = new ViteNodeRunnerWithContext({
    root,
    base: server.config.base,
    fetchModule(id) {
      return node.fetchModule(id);
    },
    resolveId(id, importer) {
      return node.resolveId(id, importer);
    },
  });

  server.watcher.on('change', (filePath) => {
    runner.moduleCache.invalidateDepTree([filePath]);
  });

  return {
    server,
    runner,
  };
};

class NormalizedMap<V> extends Map<string, V> {
  constructor(readonly root: string) {
    super();
  }

  #normalizePath(filePath: string) {
    return normalizePath(
      isAbsolute(filePath) ? filePath : join(this.root, filePath),
    );
  }

  get(filePath: string) {
    filePath = this.#normalizePath(filePath);
    return super.get(filePath);
  }

  set(filePath: string, value: V) {
    filePath = this.#normalizePath(filePath);
    return super.set(filePath, value);
  }
}

export interface Compiler {
  processVanillaFile(
    filePath: string,
    options?: {
      outputCss?: boolean;
    },
  ): Promise<{ source: string; watchFiles: Set<string> }>;
  getCssForFile(virtualCssFilePath: string): { filePath: string; css: string };
  close(): Promise<void>;
}

interface ProcessedVanillaFile {
  source: string;
  watchFiles: Set<string>;
}

export interface CreateCompilerOptions {
  root: string;
  cssImportSpecifier?: (filePath: string) => string;
  identifiers?: IdentifierOption;
  viteResolve?: ViteConfig['resolve'];
  vitePlugins?: ViteConfig['plugins'];
}
export const createCompiler = ({
  root,
  identifiers = 'debug',
  cssImportSpecifier = (filePath) => filePath + '.vanilla.css',
  viteResolve = {},
  vitePlugins = [],
}: CreateCompilerOptions): Compiler => {
  const vitePromise = createViteServer({
    root,
    identifiers,
    viteResolve,
    vitePlugins,
  });

  const processVanillaFileCache = new Map<
    string,
    {
      lastInvalidationTimestamp: number;
      result: ProcessedVanillaFile;
    }
  >();

  const cssCache = new NormalizedMap<{ css: string }>(root);
  const classRegistrationsByModuleId = new NormalizedMap<{
    localClassNames: Set<string>;
    composedClassLists: Array<Composition>;
  }>(root);

  return {
    async processVanillaFile(
      filePath,
      options = {},
    ): Promise<ProcessedVanillaFile> {
      const { server, runner } = await vitePromise;

      filePath = isAbsolute(filePath) ? filePath : join(root, filePath);
      const outputCss = options.outputCss ?? true;

      const cacheKey = Object.entries({ filePath, outputCss })
        .map((entry) => entry.join('='))
        .join('|');
      const cachedFile = processVanillaFileCache.get(cacheKey);
      if (cachedFile) {
        const moduleNode = server.moduleGraph.getModuleById(filePath);
        if (
          cachedFile.lastInvalidationTimestamp ===
          moduleNode?.lastInvalidationTimestamp
        ) {
          return cachedFile.result;
        }
      }

      const cssByModuleId = new NormalizedMap<Array<Css>>(root);
      const localClassNames = new Set<string>();
      const composedClassLists: Array<Composition> = [];

      const cssAdapter: Adapter = {
        getIdentOption: () => identifiers,
        onBeginFileScope: (fileScope) => {
          // Before evaluating a file, reset the cache for it
          const moduleId = normalizePath(fileScope.filePath);
          cssByModuleId.set(moduleId, []);
          classRegistrationsByModuleId.set(moduleId, {
            localClassNames: new Set(),
            composedClassLists: [],
          });
        },
        onEndFileScope: (fileScope) => {
          // For backwards compatibility, ensure the cache is populated even if
          // a file didn't contain any CSS. This is to ensure that the only
          // error messages shown in older versions are the ones below.
          const moduleId = normalizePath(fileScope.filePath);
          const cssObjs = cssByModuleId.get(moduleId) ?? [];
          cssByModuleId.set(moduleId, cssObjs);
        },
        registerClassName: (className, fileScope) => {
          if (!fileScope) {
            throw new Error(
              'Your version of @vanilla-extract/css must be at least v1.10.0. Please update to a compatible version.',
            );
          }

          localClassNames.add(className);

          const moduleId = normalizePath(fileScope.filePath);
          classRegistrationsByModuleId
            .get(moduleId)!
            .localClassNames.add(className);
        },
        registerComposition: (composedClassList, fileScope) => {
          if (!fileScope) {
            throw new Error(
              'Your version of @vanilla-extract/css must be at least v1.10.0. Please update to a compatible version.',
            );
          }

          composedClassLists.push(composedClassList);

          const moduleId = normalizePath(fileScope.filePath);
          classRegistrationsByModuleId
            .get(moduleId)!
            .composedClassLists.push(composedClassList);
        },
        markCompositionUsed: () => {
          // This compiler currently retains all composition classes
        },
        appendCss: (css, fileScope) => {
          const moduleId = normalizePath(fileScope.filePath);
          const cssObjs = cssByModuleId.get(moduleId) ?? [];
          cssObjs.push(css);

          cssByModuleId.set(moduleId, cssObjs);
        },
      };

      const { fileExports, cssImports, watchFiles, lastInvalidationTimestamp } =
        await lock(async () => {
          runner.cssAdapter = cssAdapter;

          const fileExports = await runner.executeFile(filePath);

          const moduleId = normalizePath(filePath);
          const moduleNode = server.moduleGraph.getModuleById(moduleId);

          if (!moduleNode) {
            throw new Error(`Can't find ModuleNode for ${filePath}`);
          }

          const cssImports = [];

          const { cssDeps, watchFiles } = scanModule(moduleNode);

          for (const cssDep of cssDeps) {
            const cssDepModuleId = normalizePath(cssDep);
            const cssObjs = cssByModuleId.get(cssDepModuleId);
            const cachedCss = cssCache.get(cssDepModuleId);
            const cachedClassRegistrations =
              classRegistrationsByModuleId.get(cssDepModuleId);

            if (!cssObjs && !cachedCss && !cachedClassRegistrations) {
              continue;
            }

            if (cssObjs) {
              let css = '';

              if (cssObjs.length > 0) {
                css = transformCss({
                  localClassNames: Array.from(localClassNames),
                  composedClassLists,
                  cssObjs,
                }).join('\n');
              }

              cssCache.set(cssDepModuleId, { css });
            } else if (cachedClassRegistrations) {
              cachedClassRegistrations.localClassNames.forEach(
                (localClassName) => {
                  localClassNames.add(localClassName);
                },
              );
              composedClassLists.push(
                ...cachedClassRegistrations.composedClassLists,
              );
            }

            if (cssObjs || cachedCss?.css) {
              cssImports.push(
                `import '${cssImportSpecifier(cssDepModuleId)}';`,
              );
            }
          }

          return {
            fileExports,
            cssImports: outputCss ? cssImports : [],
            watchFiles,
            lastInvalidationTimestamp: moduleNode.lastInvalidationTimestamp,
          };
        });

      const result: ProcessedVanillaFile = {
        source: serializeVanillaModule(
          cssImports,
          fileExports,
          null, // This compiler currently retains all composition classes
        ),
        watchFiles,
      };

      processVanillaFileCache.set(cacheKey, {
        lastInvalidationTimestamp,
        result,
      });

      return result;
    },
    getCssForFile(filePath: string) {
      filePath = isAbsolute(filePath) ? filePath : join(root, filePath);
      const moduleId = normalizePath(filePath);
      const result = cssCache.get(moduleId);

      if (!result) {
        throw new Error(`No CSS for file: ${filePath}`);
      }

      return {
        css: result.css,
        filePath: filePath,
        resolveDir: root,
      };
    },
    async close() {
      const { server } = await vitePromise;

      await server.close();
    },
  };
};
