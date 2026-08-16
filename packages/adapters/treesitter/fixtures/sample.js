import { join } from "node:path";

export function add(a, b) {
  return join(String(a), String(b));
}

class Queue {
  push(item) {
    this.item = item;
  }
}
