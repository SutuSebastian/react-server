import { createRequire, register } from "node:module";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { createMiddleware } from "@hattip/adapter-node";
import { compose } from "@hattip/compose";
import { cookie } from "@hattip/cookie";
import { cors } from "@hattip/cors";
import { parseMultipartFormData } from "@hattip/multipart";
import react from "@vitejs/plugin-react";
import {
  DevEnvironment,
  RemoteEnvironmentTransport,
  createNodeDevEnvironment,
  createServer as createViteDevServer,
  createLogger as createViteLogger,
} from "vite";

import { ESModulesEvaluator, ModuleRunner } from "vite/module-runner";
import { MemoryCache } from "../../memory-cache/index.mjs";
import packageJson from "../../package.json" assert { type: "json" };
import { getRuntime, runtime$ } from "../../server/runtime.mjs";
import {
  COLLECT_STYLESHEETS,
  CONFIG_CONTEXT,
  CONFIG_ROOT,
  FORM_DATA_PARSER,
  LOGGER_CONTEXT,
  MEMORY_CACHE_CONTEXT,
  MODULE_LOADER,
  SERVER_CONTEXT,
  WORKER_THREAD,
} from "../../server/symbols.mjs";
import { clientAlias } from "../build/resolve.mjs";
import notFoundHandler from "../handlers/not-found.mjs";
import staticWatchHandler from "../handlers/static-watch.mjs";
import trailingSlashHandler from "../handlers/trailing-slash.mjs";
import { alias } from "../loader/module-alias.mjs";
import reactServerEval from "../plugins/react-server-eval.mjs";
import reactServerRuntime from "../plugins/react-server-runtime.mjs";
import useClient from "../plugins/use-client.mjs";
import useServerInline from "../plugins/use-server-inline.mjs";
import useServer from "../plugins/use-server.mjs";
import * as sys from "../sys.mjs";
import merge from "../utils/merge.mjs";
import createLogger from "./create-logger.mjs";
import ssrHandler from "./ssr-handler.mjs";

alias("react-server");
register("../loader/node-loader.react-server.mjs", import.meta.url);

const __require = createRequire(import.meta.url);
const packageName = packageJson.name;
const cwd = sys.cwd();
const rootDir = join(dirname(__require.resolve(`${packageName}`)), "/../");

export default async function createServer(root, options) {
  const config = getRuntime(CONFIG_CONTEXT)?.[CONFIG_ROOT];
  let reactServerRouterModule;
  try {
    reactServerRouterModule = __require.resolve("@lazarv/react-server-router", {
      paths: [cwd],
    });
  } catch {
    // ignore
    root ||= "virtual:react-server-eval.jsx";
  }

  const worker = new Worker(new URL("./render-stream.mjs", import.meta.url));
  runtime$(WORKER_THREAD, worker);

  const devServerConfig = {
    ...config,
    server: {
      ...config.server,
      middlewareMode: true,
      cors: options.cors ?? config.server?.cors,
      hmr: {
        port: 21678 + parseInt(options.port ?? config.server?.port ?? 0),
        ...config.server?.hmr,
      },
      https: options.https ?? config.server?.https,
      fs: {
        ...config.server?.fs,
        allow: [cwd, rootDir, ...(config.server?.fs?.allow ?? [])],
      },
    },
    publicDir: false,
    root: cwd,
    appType: "custom",
    clearScreen: options.clearScreen,
    configFile: false,
    optimizeDeps: {
      ...config.optimizeDeps,
      force: options.force ?? config.optimizeDeps?.force,
    },
    css: {
      ...config.css,
      postcss: cwd,
    },
    plugins: [
      ...(reactServerRouterModule &&
      (!root || root === "@lazarv/react-server-router")
        ? [
            (async () =>
              (
                await import(
                  __require.resolve("@lazarv/react-server-router/plugin", {
                    paths: [cwd],
                  })
                )
              ).default())(),
          ]
        : []),
      reactServerEval(options),
      reactServerRuntime(),
      react(),
      useClient(),
      useServer(),
      useServerInline(),
      ...(config.plugins ?? []),
    ],
    cacheDir: join(cwd, ".react-server/.cache/client"),
    resolve: {
      ...config.resolve,
      preserveSymlinks: true,
      alias: [
        { find: /^@lazarv\/react-server$/, replacement: rootDir },
        ...(config.resolve?.alias ?? []),
      ],
    },
    customLogger: createLogger(),
    optimizeDeps: {
      ...config.optimizeDeps,
      include: ["react-dom/client", "react-server-dom-webpack/client.browser"],
    },
    environments: {
      client: {
        resolve: {
          preserveSymlinks: false,
          alias: [
            { find: /^@lazarv\/react-server$/, replacement: rootDir },
            ...clientAlias(true),
            ...(config.resolve?.alias ?? []),
          ],
        },
        optimizeDeps: {
          ...config.optimizeDeps,
          include: ["react-dom/client"],
        },
        dev: {
          createEnvironment: (name, config) => {
            const dev = new DevEnvironment(
              name,
              {
                ...config,
                resolve: {
                  alias: [
                    { find: /^@lazarv\/react-server$/, replacement: rootDir },
                    ...clientAlias(true),
                    ...(config.resolve?.alias ?? []),
                  ],
                },
                logger: createViteLogger("info", {
                  prefix: `[react-server]`,
                }),
              },
              {}
            );
            return dev;
          },
        },
      },
      ssr: {
        resolve: {
          external: [
            "react",
            "react/jsx-dev-runtime",
            "react-dom",
            "react-dom/client",
            "react-server-dom-webpack",
          ],
          conditions: ["default"],
          externalConditions: ["default"],
        },
        dev: {
          createEnvironment: (name, config) => {
            return createNodeDevEnvironment(
              name,
              {
                ...config,
                root: rootDir,
                cacheDir: join(cwd, ".react-server/.cache/ssr"),
                resolve: {
                  external: [
                    "react",
                    "react/jsx-dev-runtime",
                    "react-dom",
                    "react-dom/client",
                    "react-server-dom-webpack",
                  ],
                  alias: [
                    { find: /^@lazarv\/react-server$/, replacement: rootDir },
                    ...clientAlias(true),
                    ...(config.resolve?.alias ?? []),
                  ],
                  conditions: ["default"],
                  externalConditions: ["default"],
                },
                logger: createViteLogger("info", {
                  prefix: `[react-server]`,
                }),
              },
              {
                runner: {
                  transport: new RemoteEnvironmentTransport({
                    send: (data) => {
                      worker.postMessage({ type: "import", data });
                    },
                    onMessage: (listener) => {
                      worker.on("message", (payload) => {
                        if (payload.type === "import") {
                          listener(payload.data);
                        }
                      });
                    },
                  }),
                },
              }
            );
          },
        },
      },
      rsc: {
        resolve: {
          alias: [{ find: /^@lazarv\/react-server$/, replacement: rootDir }],
          external: [
            "react",
            "react-dom",
            "react-server-dom-webpack",
            ...(config.ssr?.external ?? []),
            ...(config.external ?? []),
          ],
          conditions: ["react-server"],
          externalConditions: ["react-server"],
        },
        dev: {
          createEnvironment: (name, config) => {
            const dev = createNodeDevEnvironment(
              name,
              {
                ...config,
                root: rootDir,
                cacheDir: join(cwd, ".react-server/.cache/rsc"),
                optimizeDeps: {
                  ...config.optimizeDeps,
                  include: [],
                },
                resolve: {
                  external: [
                    // "react",
                    "react-dom",
                    "react-server-dom-webpack",
                    ...(config.ssr?.external ?? []),
                    ...(config.external ?? []),
                  ],
                  conditions: ["react-server"],
                  externalConditions: ["react-server"],
                },
                logger: createViteLogger("info", {
                  prefix: `[react-server]`,
                }),
              },
              {}
            );
            return dev;
          },
        },
      },
    },
  };

  const viteConfig =
    typeof config.vite === "function"
      ? config.vite(devServerConfig) ?? devServerConfig
      : merge(devServerConfig, config.vite);

  const viteDevServer = await createViteDevServer(viteConfig);
  viteDevServer.environments.client.hot = viteDevServer.ws;
  viteDevServer.environments.rsc.watcher = viteDevServer.watcher;
  viteDevServer.environments.rsc.hot = {
    send: (data) => {
      data.triggeredBy = data.triggeredBy?.replace(rootDir, cwd + "/");
      if (
        !viteDevServer.environments.client.moduleGraph.idToModuleMap.has(
          data.triggeredBy
        )
      ) {
        viteDevServer.environments.client.hot.send(data);
      }
    },
  };

  const moduleRunner = new ModuleRunner(
    {
      root: cwd,
      transport: viteDevServer.environments.rsc,
    },
    new ESModulesEvaluator()
  );

  const initialRuntime = {
    [SERVER_CONTEXT]: viteDevServer,
    [LOGGER_CONTEXT]: viteDevServer.config.logger,
    [MODULE_LOADER]: ($$id) => {
      const [id] = $$id.split("#");
      moduleRunner.moduleCache.invalidateUrl(id);
      return moduleRunner.import(id);
    },
    [FORM_DATA_PARSER]: parseMultipartFormData,
    [MEMORY_CACHE_CONTEXT]: new MemoryCache(),
    [COLLECT_STYLESHEETS]: function collectCss(rootModule) {
      const styles = [];
      const visited = new Set();
      function collectCss(moduleId) {
        if (
          moduleId &&
          !visited.has(moduleId) &&
          !moduleId.startsWith("virtual:")
        ) {
          visited.add(moduleId);
          const mod =
            viteDevServer.environments.rsc.moduleGraph.getModuleById(moduleId);
          if (!mod) return;

          const values = Array.from(mod.importedModules.values());
          const importedStyles = values.filter(
            (mod) => /\.(css|scss|less)/.test(mod.id) && !styles.includes(mod)
          );
          const imports = values.filter(
            (mod) => !/\.(css|scss|less)/.test(mod.id)
          );

          styles.push(...importedStyles.map((mod) => mod.url));
          imports.forEach((mod) => mod.id && collectCss(mod.id));
        }
      }
      collectCss(rootModule);
      return styles;
    },
  };

  runtime$(
    typeof config.runtime === "function"
      ? config.runtime(initialRuntime) ?? initialRuntime
      : {
          ...initialRuntime,
          ...config.runtime,
        }
  );

  const publicDir =
    typeof config.public === "string" ? config.public : "public";
  const initialHandlers = [
    ...(config.public !== false
      ? [
          await staticWatchHandler(join(cwd, publicDir), {
            cwd: publicDir,
          }),
        ]
      : []),
    await trailingSlashHandler(),
    cookie(config.cookies),
    ...(config.handlers?.pre ?? []),
    await ssrHandler(root),
    ...(config.handlers?.post ?? []),
    await notFoundHandler(),
  ];
  if (options.cors) {
    initialHandlers.unshift(cors());
  }

  viteDevServer.middlewares.use(
    createMiddleware(
      compose(
        typeof config.handlers === "function"
          ? config.handlers(initialHandlers) ?? initialHandlers
          : [...initialHandlers, ...(config.handlers ?? [])]
      )
    )
  );

  return {
    listen: (...args) => {
      viteDevServer.environments.client.hot.listen();
      return viteDevServer.middlewares.listen(...args);
    },
    close: () => {
      viteDevServer.close();
      viteDevServer.environments.client.hot.close();
    },
    ws: viteDevServer.environments.client.hot,
    middlewares: viteDevServer.middlewares,
  };
}
