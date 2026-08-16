import { readFile } from "node:fs";

export function payGate(amount: number): boolean {
  return amount > 0;
}

export class Ledger {
  post(entry: string): void {
    void entry;
  }
}

interface Entry {
  id: string;
}

type Cents = number;

export const LIMIT = 100;

export { payGate as gate };
