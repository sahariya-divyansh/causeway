import { encodeDelta } from "./delta.js";
import type { RegisterEntry } from "./crdt.js";

const delta: Record<string, RegisterEntry<unknown>> = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => {
    const clientId = index % 2 === 0 ? "mumbai-pos-7" : "delhi-field-3";

    return [
      `invoice:${1000 + index}`,
      {
        value: {
          invoiceId: `INV-${1000 + index}`,
          customerName: ["Asha Retail", "Kiran Medical", "Northeast Traders"][index % 3],
          amountPaise: 149900 + index * 7500,
          status: index % 4 === 0 ? "paid" : "pending",
          updatedFromNetwork: index % 5 === 0 ? "2g-intermittent" : "offline-cache",
        },
        timestamp: 1_725_000_000_000 + index * 1000,
        vectorClock: {
          "mumbai-pos-7": index + 1,
          "delhi-field-3": Math.floor(index / 2),
        },
        clientId,
      },
    ];
  }),
);

const jsonBytes = Buffer.byteLength(JSON.stringify(delta));
const cborBytes = encodeDelta(delta).byteLength;
const savings = ((jsonBytes - cborBytes) / jsonBytes) * 100;

console.log(
  `JSON: ${jsonBytes} bytes | CBOR: ${cborBytes} bytes | Savings: ${savings.toFixed(1)}%`,
);
