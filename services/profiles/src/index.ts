import { checkHash, checkRawToken, disableService, getLog, setServerJsonFormat } from "juava";
import express from "express";
import Prometheus from "prom-client";
import { Server } from "node:net";
import { getHeapSnapshot } from "node:v8";
import { functionsStore, workspaceStore } from "./lib/repositories";
import { db } from "./lib/db";
import { profileBuilder, ProfileBuilderRunner } from "./builder";
import { createClickhouseLogger, DummyEventsStore, EventsStore, mongodb } from "@jitsu/core-functions";

const log = getLog("profile-builder");

setServerJsonFormat(process.env.LOG_FORMAT === "json");

const http = express();
http.use(express.json({ limit: "20mb" }));
http.use(express.urlencoded({ limit: "20mb" }));

const metricsHttp = express();

const httpPort = process.env.HTTP_PORT || process.env.PORT || 3402;
const metricsPort = process.env.METRICS_PORT || 9091;

let started = false;
let closed = false;

const profileBuilders: Map<string, ProfileBuilderRunner> = new Map();
const repoUpdateInterval = process.env.REPOSITORY_REFRESH_PERIOD_SEC
  ? parseInt(process.env.REPOSITORY_REFRESH_PERIOD_SEC) * 1000
  : 2000;

async function main() {
  const errorTypes = ["unhandledRejection", "uncaughtException"];
  const signalTraps = ["SIGTERM", "SIGINT", "SIGUSR2"];

  errorTypes.forEach(type => {
    process.on(type, err => {
      log.atError().withCause(err).log(`process.on ${type}`);
    });
  });

  process.on("exit", code => {
    log.atInfo().log(`Process exited with code ${code}`);
  });

  await mongodb.waitInit();
  let eventsLogger: EventsStore = DummyEventsStore;
  if (process.env.CLICKHOUSE_HOST || process.env.CLICKHOUSE_URL) {
    eventsLogger = createClickhouseLogger();
  }

  let httpServer: Server;
  let metricsServer: Server | undefined;

  const gracefulShutdown = async () => {
    closed = true;

    for (const [pbId, profileBuilder] of profileBuilders) {
      await profileBuilder
        .close()
        .catch(e =>
          log.atError().withCause(e).log(`Failed to shutdown profile builder for: ${pbId} v: ${profileBuilder.version}`)
        );
    }

    if (eventsLogger) {
      eventsLogger.close();
    }
    if (httpServer) {
      httpServer.close();
    }

    workspaceStore.stop();
    functionsStore.stop();
    await db.pgPool.close();

    const extraDelay = process.env.SHUTDOWN_EXTRA_DELAY_SEC
      ? 1000 * parseInt(process.env.SHUTDOWN_EXTRA_DELAY_SEC)
      : 5000;
    if (extraDelay > 0) {
      log.atInfo().log(`Giving extra ${extraDelay / 1000}s. to flush logs and scrape metrics...`);
      //extra time to flush logs
      setTimeout(() => {
        if (metricsServer) {
          metricsServer.close();
        }
        process.exit(started ? 0 : 1);
      }, extraDelay);
    }
  };

  signalTraps.forEach(type => {
    process.once(type, () => {
      gracefulShutdown();
    });
  });

  try {
    Prometheus.collectDefaultMetrics();
    await db.pgPool.waitInit();

    const ws = await workspaceStore.get();
    if (!ws.enabled) {
      log.atError().log("Connection store is not configured. Profile Builder will not work");
      process.exit(1);
    }
    const funcStore = await functionsStore.get();
    if (!funcStore.enabled) {
      log.atError().log("Functions store is not configured. Profile Builder will not work");
      process.exit(1);
    }

    metricsServer = initMetricsServer();
  } catch (e) {
    log.atError().withCause(e).log("Failed to start");
    process.exit(1);
  }

  httpServer = initHTTP();

  refreshLoop(eventsLogger);
}

function refreshLoop(eventsLogger: EventsStore) {
  (async () => {
    while (!closed) {
      const started = Date.now();
      const ws = workspaceStore.getCurrent()!;
      const actualProfileBuilders = new Set<string>();
      for (const [workspaceId, workspace] of Object.entries(ws.getAll())) {
        for (const pb of workspace.profileBuilders) {
          try {
            const currentPb = profileBuilders.get(pb.id);
            if (currentPb) {
              if (pb.version != currentPb.version()) {
                await currentPb.close();
                profileBuilders.delete(pb.id);
                profileBuilders.set(pb.id, await profileBuilder(workspaceId, pb, eventsLogger));
              }
            } else {
              profileBuilders.set(pb.id, await profileBuilder(workspaceId, pb, eventsLogger));
            }
            actualProfileBuilders.add(pb.id);
          } catch (e) {
            log.atError().withCause(e).log(`Failed to start profile builder for: ${pb.id} v: ${pb.version}`);
          }
        }
      }
      for (const [pbId, pb] of profileBuilders) {
        if (!actualProfileBuilders.has(pbId)) {
          try {
            await pb.close();
            profileBuilders.delete(pbId);
          } catch (e) {
            log.atError().withCause(e).log(`Failed to shutdown profile builder for: ${pbId} v: ${pb.version}`);
          }
        }
      }
      const waitMs = repoUpdateInterval - (Date.now() - started);
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, repoUpdateInterval));
      }
    }
  })().catch(async e => {
    log.atError().withCause(e).log("Failed");
    process.kill(process.pid, "SIGTERM");
  });
}

function initHTTP() {
  http.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/version") {
      return next();
    }
    let token = req.headers.authorization || "";
    if (token) {
      if (token.startsWith("Bearer ")) {
        token = token.substring("Bearer ".length);
      } else {
        res.status(401).json({ error: "Authorization header with Bearer token is required" });
        return;
      }
    }
    if (!checkAuth(token)) {
      if (token) {
        res.status(401).json({ error: `Invalid token: ${token}` });
      } else {
        res.status(401).json({ error: "Authorization header with Bearer token is required" });
      }
      return;
    }
    next();
  });
  http.get("/health", (req, res) => {
    res.json({
      status: "pass",
      workspaceStore: {
        enabled: workspaceStore.getCurrent()?.enabled || "loading",
        status: workspaceStore.status(),
        lastUpdated: workspaceStore.lastRefresh(),
        lastModified: workspaceStore.lastModified(),
      },
      functionsStore: {
        enabled: functionsStore.getCurrent()?.enabled || "loading",
        status: functionsStore.status(),
        lastUpdated: functionsStore.lastRefresh(),
        lastModified: functionsStore.lastModified(),
      },
    });
  });
  http.get("/wtfheap", async (req, res) => {
    const snapshot = getHeapSnapshot();
    log.atInfo().log("snapshot");
    snapshot.pipe(res);
    log.atInfo().log("snapshot2");
  });
  const httpServer = http.listen(httpPort, () => {
    log.atInfo().log(`Listening on port ${httpPort}`);
    started = true;
  });
  httpServer.on("error", e => {
    log.atError().withCause(e).log("Failed to start http server. Exiting...");
    process.kill(process.pid, "SIGTERM");
  });
  return httpServer;
}

function initMetricsServer() {
  metricsHttp.get("/metrics", async (req, res) => {
    res.set("Content-Type", Prometheus.register.contentType);
    const result = await Prometheus.register.metrics();
    res.end(result);
  });
  const metricsServer = metricsHttp.listen(metricsPort, () => {
    log.atInfo().log(`Listening metrics on port ${metricsPort}`);
  });
  metricsServer.on("error", e => {
    log.atError().withCause(e).log("Failed to start metrics server");
  });
  return metricsServer;
}

function checkAuth(token: string): boolean {
  let tokens: string[] = [];
  let checkFunction: (token: string, secret: string) => boolean = () => false;
  if (process.env.ROTOR_AUTH_TOKENS) {
    tokens = process.env.ROTOR_AUTH_TOKENS.split(",");
    checkFunction = checkHash;
  } else if (process.env.ROTOR_RAW_AUTH_TOKENS) {
    tokens = process.env.ROTOR_RAW_AUTH_TOKENS.split(",");
    checkFunction = checkRawToken;
  } else {
    log.atWarn().log("No auth tokens are configured. Profile Builder is open for everyone.");
    return true;
  }
  if (tokens.length > 0) {
    for (const tokenHashOrPlain of tokens) {
      if (checkFunction(tokenHashOrPlain, token)) {
        return true;
      }
    }
  }
  return false;
}

main();

export {};