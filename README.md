# @pup/telemetry

This package empowers (Node, Deno or Bun) processes run by Pup with telemetry
and inter process communication capabilities, providing:

- **Process Metric Reporting:** Automatic reporting of crucial process metrics
  (e.g., memory usage, CPU utilization) back to the main Pup process for
  enhanced monitoring and insights.
- **Inter-Process Communication (IPC):** A flexible IPC mechanism for
  communication between Pup-managed processes and the Pup main process.

**Installation**

```bash
deno add @pup/telemetry
```

or

```bash
npx jsr install @pup/telemetry
```

**Usage**

**1. Basic Telemetry (Metric Reporting)**

```typescript
import { PupTelemetry } from "@pup/telemetry";

const telemetry = new PupTelemetry(); // Initializes telemetry

// ... Your application code ...

telemetry.close(); // Allow the process to exit
```

2. **Inter-Process Communication (IPC)**

   ```typescript
   import { PupTelemetry } from "@pup/telemetry";
   const telemetry = new PupTelemetry();

   // One part of your application:

   telemetry.on("my-event", (data) => {
     console.log(`Received 'my-event' with data: ${JSON.stringify(data)}`);
   });

   // In another part:

   telemetry.emit("another-process-id", "my-event", { data: { to: "send" } });

   // Always, to allow the processes to exit:
   telemetry.close();
   ```

**Examples**

For detailed usage examples, please refer to the Pup documentation
<https://pup.56k.guru>.

**Development and Contributions**

The `@pup/telemetry` package is actively maintained by the Pup development team.
If you have suggestions for improvements, bug fixes, or additional features,
please open an issue on the GitHub repository.

This library follows semantic versioning. For a detailed history of changes,
please refer to the CHANGELOG.md

**License**

This package is released under the MIT License.
