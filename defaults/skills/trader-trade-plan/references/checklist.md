# Trade Plan Checklist

- Preserve the thesis `chosenScenario`; do not invent a new setup.
- Respect `executionPolicy.allowedOrderTypes` and `executionPolicy.requireProtection` exactly.
- Keep orders deterministic, with explicit size and trigger logic when available.
- Prefer `skip` when the thesis cannot be translated into a compliant order plan.
