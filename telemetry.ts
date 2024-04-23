/**
 * Optional entrypoint for Pup client processes written in Deno, which periodically sends
 * memory usage and current working directory to the main Pup process.
 *
 * Usage:
 *
 *     //  Early in your application entrypoint - pin to a specific version similar
 *     import { PupTelemetry } from "jsr:@pup/telemetry"
 *     const telemetry = PupTelemetry()
 *
 *     // The rest of your application
 *     console.log("Hello World!")
 *
 *     // As PupTelemetry uses the singleton pattern, you can now use the same instance
 *     // anywhere in your application
 *     const telemetry = PupTelemetry()
 *
 *     // To receive messages from another process, use
 *     telemetry.on('event_name', (event) => { console.log(event) });
 *
 *     // To send messages to another process, use
 *     telemetry.emit('target-process-id', 'event_name', { any: { event: "data" }} );
 *
 *     // To stop the telemetry and allow the process to exit, use the following:
 *     telemetry.stop()
 *
 * @file      telemetry.ts
 * @license   MIT
 */

import { EventEmitter, type EventHandler } from "@pup/common/eventemitter";
import { FileIPC } from "@pup/common/ipc";
import { cwd, isDir } from "@cross/fs";
import { getEnv } from "@cross/env";
import { PupRestClient } from "@pup/api-client";
import type { ApiMemoryUsage, ApiTelemetryData } from "@pup/api-definitions";
import { CurrentRuntime, Runtime } from "@cross/runtime";

export class PupTelemetry {
  private static instance: PupTelemetry;

  private events: EventEmitter = new EventEmitter();

  private intervalSeconds = 15;

  private timer?: number;
  private aborted = false;
  private ipc?: FileIPC;

  /**
   * PupTelemetry singleton instance.
   * The `new` keyword is optional.
   * @param intervalSeconds - The interval in seconds between telemetry data transmissions (default: 15).
   *                          Value is clamped between 1 and 180 seconds.
   */
  constructor(intervalSeconds = 5) {
    // Use as a factory if called without the keyword `new`
    if (!(this instanceof PupTelemetry)) {
      return new PupTelemetry(intervalSeconds);
    }

    // Re-use existing instance (singleton pattern)
    if (PupTelemetry.instance) {
      return PupTelemetry.instance;
    }

    // Set instance to the newly created object (singleton pattern)
    PupTelemetry.instance = this;

    // Clamp intervalSeconds between 1 and 180 seconds before storing
    if (!intervalSeconds || intervalSeconds < 1) intervalSeconds = 1;
    if (intervalSeconds > 180) intervalSeconds = 180;
    this.intervalSeconds = intervalSeconds;
    // Start the watchdog
    this.telemetryWatchdog();
    // Start the IPC
    this.checkIpc();
  }

  /**
   * Main telemetry data is sent back to the main process using the rest API
   */
  private sendMainTelemetry() {
    const pupProcessId = getEnv("PUP_PROCESS_ID");
    let memoryUsage: ApiMemoryUsage;
    if (CurrentRuntime === Runtime.Deno) {
      //@ts-ignore cross-runtime
      const { external, heapTotal, heapUsed, rss } = Deno.memoryUsage();
      memoryUsage = { external, heapTotal, heapUsed, rss };
    } else if (
      CurrentRuntime === Runtime.Node || CurrentRuntime === Runtime.Bun
    ) {
      //@ts-ignore cross-runtime
      const { external = 0, heapTotal, heapUsed, rss } = process.memoryUsage();
      memoryUsage = { external, heapTotal, heapUsed, rss };
    } else {
      memoryUsage = { external: 0, heapTotal: 0, heapUsed: 0, rss: 0 };
    }
    if (pupProcessId) {
      const data: ApiTelemetryData = {
        sender: pupProcessId,
        memory: memoryUsage,
        sent: new Date().toISOString(),
        cwd: cwd(),
      };
      this.emit("main", "telemetry", data);
    } else {
      // Ignore, process not run by Pup?
    }
  }

  private async checkIpc() {
    const pupTempPath = getEnv("PUP_TEMP_STORAGE");
    const pupProcessId = getEnv("PUP_PROCESS_ID");

    if (pupTempPath && (await isDir(pupTempPath)) && pupProcessId) {
      const ipcPath = `${pupTempPath}/.${pupProcessId}.ipc`; // Process-specific IPC path
      // Break out if aborted
      if (!this.aborted) {
        this.ipc = new FileIPC(ipcPath);

        // Read incoming messages
        for await (const messages of this.ipc.receiveData()) {
          // Break out of the loop if aborted
          if (this.aborted) break;

          if (messages.length > 0) {
            // Process messages and emit events
            for (const message of messages) {
              try {
                if (message.data) {
                  const parsedMessage = JSON.parse(message.data);
                  this.events.emit(
                    parsedMessage.event,
                    parsedMessage.eventData,
                  );
                }
              } catch (_e) {
                // Ignore errors in message parsing and processing
              }
            }
          }
        }
      }
    }
  }

  /**
   * The watchdog is guarded by a try/catch block and recursed by a unrefed
   * timer to prevent the watchdog from keeping a process alive.
   */
  private async telemetryWatchdog() {
    try {
      await this.sendMainTelemetry();
    } catch (_e) {
      // Ignore errors
    } finally {
      clearTimeout(this.timer);
      if (!this.aborted) {
        this.timer = setTimeout(
          () => this.telemetryWatchdog(),
          this.intervalSeconds * 1000,
        );
        if (CurrentRuntime === Runtime.Deno) {
          // @ts-ignore cross-runtime
          Deno.unrefTimer(this.timer);
        } else if (
          CurrentRuntime === Runtime.Node || CurrentRuntime === Runtime.Bun
        ) {
          // @ts-ignore cross-runtime
          this.timer.unref();
        } else {
          // Ignore
        }
      }
    }
  }

  on<T>(event: string, fn: EventHandler<T>) {
    this.events.on(event, fn);
  }

  off<T>(event: string, fn: EventHandler<T>) {
    this.events.off(event, fn);
  }

  async emit<T>(targetProcessId: string, event: string, eventData?: T) {
    // If target is main (pup host process, use the secure rest api), for child-process to child-process
    // use the file based bus
    if (targetProcessId === "main") {
      try {
        const pupApiHostname = getEnv("PUP_API_HOSTNAME");
        const pupApiPort = getEnv("PUP_API_PORT");
        const pupApiToken = getEnv("PUP_API_TOKEN");
        if (pupApiHostname && pupApiPort && pupApiToken) {
          // Send api request
          const apiBaseUrl = `http://${pupApiHostname}:${pupApiPort}`;
          const client = new PupRestClient(apiBaseUrl, pupApiToken);
          client.sendTelemetry(eventData as ApiTelemetryData);
        }
      } catch (_e) {
        console.error(_e);
      }
    } else {
      const pupTempPath = getEnv("PUP_TEMP_STORAGE");
      if (pupTempPath && (await isDir(pupTempPath)) && targetProcessId) {
        const ipcPath = `${pupTempPath}/.${targetProcessId}.ipc`; // Target process IPC path

        // Create a temporary IPC to send the message
        const ipc = new FileIPC(ipcPath);

        // Create the message with event and eventData
        const message = { event, eventData };

        // Send the message to the target process
        try {
          await ipc.sendData(JSON.stringify(message));
        } finally {
          // Close the temporary IPC
          ipc.close(true);
        }
      } else {
        // Ignore, process not run by Pup?
      }
    }
  }

  close() {
    this.aborted = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    if (this.ipc) {
      this.ipc.close();
    }

    this.events.close();
  }
}
