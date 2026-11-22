import { closeIdleLifecycle, runWithIdleActivity } from "../../dist/services/idle-lifecycle.js";

await runWithIdleActivity(async () => {
  process.send?.({ state: "busy" });
  await new Promise((resolve) => process.once("message", resolve));
});
await closeIdleLifecycle();
process.disconnect?.();
