import { readFile } from "node:fs/promises";

import colors from "picocolors";
import strip from "strip-ansi";

import packageJson from "../../package.json" with { type: "json" };
import { getContext } from "../../server/context.mjs";
import {
  HTTP_HEADERS,
  HTTP_STATUS,
  RENDER_CONTEXT,
  SERVER_CONTEXT,
} from "../../server/symbols.mjs";
import { replaceError } from "../utils/error.mjs";

function cleanStack(stack) {
  return stack
    .split(/\n/g)
    .filter((l) => /^\s*at/.test(l))
    .map((l) => l.trim())
    .join("\n");
}

export async function prepareError(err) {
  try {
    if (!err.id) {
      const viteDevServer = getContext(SERVER_CONTEXT);
      const [id, line, column] =
        err.stack
          .split("\n")[1]
          .match(/\((.*:[0-9]+:[0-9]+)\)/)?.[1]
          .split(":") ?? [];

      if (viteDevServer.environments.ssr.moduleGraph.idToModuleMap.has(id)) {
        const map = viteDevServer.environments.ssr.moduleGraph.getModuleById(id)
          ?.ssrTransformResult?.map ?? {
          sourcesContent: [await readFile(id, "utf-8")],
        };

        err.id = id;
        if (!err.loc) {
          err.loc = {
            file: id,
            column: parseInt(column, 10),
            line: parseInt(line, 10),
            length: 0,
            lineText: "",
            namespace: "",
            suggestion: "",
          };
        }

        if (!err.frame) {
          const lines = map.sourcesContent[0].split("\n");
          const start = Math.max(0, err.loc.line - 3);
          const end = Math.min(lines.length, err.loc.line + 3);
          const frame = lines
            .slice(start, end)
            .flatMap((l, i) => {
              const curr = i + start;
              const indent = " ".repeat(
                Math.max(start, end).toString().length - curr.toString().length
              );
              return [
                `${indent}${curr} | ${l}`,
                ...(i === 2
                  ? [
                      `${indent}${curr
                        .toString()
                        .replaceAll(
                          /./g,
                          " "
                        )} |${" ".repeat(err.loc.column)}^`,
                    ]
                  : []),
              ];
            })
            .join("\n");
          err.frame = `${err.message}\n${frame}\n`;
        }
      }

      err.plugin = err.plugin || packageJson.name;
    }
  } catch (e) {
    console.error(colors.red(e.stack));
  }
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || "")),
    id: err.id,
    frame: strip(err.frame || ""),
    plugin: err.plugin,
    pluginCode: err.pluginCode?.toString(),
    loc: err.loc,
  };
}

function plainResponse(e) {
  const httpStatus = getContext(HTTP_STATUS) ?? {
    status: 500,
    statusText: "Internal Server Error",
  };
  const headers = getContext(HTTP_HEADERS) ?? new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");

  return new Response(e?.stack ?? null, {
    ...httpStatus,
    headers,
  });
}

export default async function errorHandler(err) {
  try {
    err = replaceError(err);

    const server = getContext(SERVER_CONTEXT);
    // TODO: is there a better way to check if this is a vite dev server?
    if (typeof server?.ssrFixStacktrace !== "function") {
      return plainResponse(err);
    }

    const renderContext = getContext(RENDER_CONTEXT);
    if (renderContext?.flags?.isRSC) {
      return plainResponse(err);
    }

    const httpStatus = getContext(HTTP_STATUS) ?? {
      status: 500,
      statusText: "Internal Server Error",
    };

    const headers = getContext(HTTP_HEADERS) ?? new Headers();
    headers.set("Content-Type", "text/html; charset=utf-8");

    const error = await prepareError(err);

    const viteDevServer = getContext(SERVER_CONTEXT);
    if (viteDevServer) {
      try {
        viteDevServer.environments.client.moduleGraph.invalidateAll();
        viteDevServer.environments.ssr.moduleGraph.invalidateAll();
        viteDevServer.environments.rsc.moduleGraph.invalidateAll();
      } catch {
        // ignore
      }
    }

    return new Response(
      `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Error</title>
        <script type="module" src="${`${server.config.base || "/"}/@vite/client`.replace(/\/+/g, "/")}"></script>
        <script type="module" src="${`${server.config.base || "/"}/@hmr`.replace(/\/+/g, "/")}"></script>
        <script type="module">
          import { ErrorOverlay } from "${`${server.config.base || "/"}/@vite/client`.replace(/\/+/g, "/")}";
          document.body.appendChild(new ErrorOverlay(${JSON.stringify(
            error
          ).replace(/</g, "\\u003c")}))
        </script>
      </head>
      <body>
      </body>
    </html>`,
      {
        ...httpStatus,
        headers,
      }
    );
  } catch (e) {
    return plainResponse(e);
  }
}
